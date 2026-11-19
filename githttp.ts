// Git smart HTTP: info/refs advertisements, git-upload-pack (protocol v2
// and v0) and git-receive-pack (v0 only). The shapes below follow what a real
// git client parses: pkt-line advertisements, sideband pack framing, and the
// report-status stream for pushes.

import type { Repo, Store } from './store.ts';
import {
  ZERO_OID,
  isObjectId,
  pktLine,
  PKT_FLUSH,
  PKT_DELIM,
  parsePktLines,
  sideband,
  objectId,
  readPack,
  writePack,
  walkCommits,
  collectObjects,
  isAncestor,
  parseCommit,
  parseTree,
  buildTree,
  buildCommit,
} from './gitobj.ts';

export interface HttpReply {
  status: number;
  contentType: string;
  body: Buffer;
}

export function jsonReply(status: number, value: unknown): HttpReply {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify(value), 'utf8') };
}

function notFound(): HttpReply {
  return jsonReply(404, { message: 'Not Found' });
}

const AGENT = 'forge/1.0';
const V2_CAPS = `ls-refs=unborn\nfetch=shallow filter\nobject-format=sha1\nagent=${AGENT}\n`;
const V0_UPLOAD_CAPS = `symref=HEAD:refs/heads/main multi_ack thin-pack side-band-64k ofs-delta shallow agent=${AGENT}`;
const V0_RECEIVE_CAPS = `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs of a repo, in git's advertisement order: HEAD, branches, tags,
 *  with a peeled line after each annotated tag. */
function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(defaultRef);
  lines.push({ oid: tip ?? ZERO_OID, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) ?? ZERO_OID;
    const entry: RefLine = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 4) {
      const text = obj.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match) entry.peeled = match[1];
    }
    lines.push(entry);
  }
  return lines;
}

function v0Advertisement(repo: Repo, service: string, caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const lines = refLines(repo);
  if (repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const line of lines) {
      parts.push(pktLine(first ? `${line.oid} ${line.name}\0${caps}\n` : `${line.oid} ${line.name}\n`));
      first = false;
      if (line.peeled) parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
  ];
  for (const cap of V2_CAPS.split('\n').filter((line) => line !== '')) {
    parts.push(pktLine(`${cap}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string, protocol2: boolean): HttpReply {
  const repo = store.resolve(owner, repoName);
  if (!repo) return notFound();
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, service, V0_RECEIVE_CAPS) };
  }
  if (service === 'git-upload-pack') {
    if (protocol2) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, service, V0_UPLOAD_CAPS) };
  }
  return notFound();
}

// ---------------------------------------------------------------- upload-pack

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallowOld: string[];
  depth?: number;
  filter?: string;
}

/** The objects a fetch must send, and the shallow lines it must report. */
function planFetch(repo: Repo, plan: FetchPlan): { objects: Map<string, { type: number; data: Buffer }>; shallow: string[]; unshallow: string[] } {
  // A want may name a tag object: the tag itself has to travel in the pack,
  // and the walk starts from the object the tag points at (tags can chain).
  const tagObjects = new Map<string, { type: number; data: Buffer }>();
  const resolvedWants: string[] = [];
  for (const want of plan.wants) {
    let current = want;
    const seen = new Set<string>();
    while (true) {
      const obj = repo.objects.get(current);
      if (!obj || obj.type !== 4 || seen.has(current)) break;
      seen.add(current);
      tagObjects.set(current, obj);
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (!match) break;
      current = match[1];
    }
    resolvedWants.push(current);
  }
  const { commits, boundary } = walkCommits(repo, resolvedWants, plan.depth);
  const wanted = collectObjects(repo, commits);
  for (const [oid, obj] of tagObjects) wanted.set(oid, obj);
  // Objects the client already holds: reachable from its haves. A have that
  // is an old shallow boundary only counts as itself plus its tree and blobs,
  // never its parents.
  const held = new Map<string, { type: number; data: Buffer }>();
  const heldFull = plan.haves.filter((have) => !plan.shallowOld.includes(have));
  const heldShallow = plan.haves.filter((have) => plan.shallowOld.includes(have));
  for (const [oid, obj] of collectObjects(repo, walkCommits(repo, heldFull).commits)) held.set(oid, obj);
  for (const [oid, obj] of collectObjects(repo, walkCommits(repo, heldShallow, 1).commits)) held.set(oid, obj);
  const objects = new Map<string, { type: number; data: Buffer }>();
  for (const [oid, obj] of wanted) {
    if (!held.has(oid)) objects.set(oid, obj);
  }
  if (plan.filter === 'blob:none') {
    for (const [oid, obj] of [...objects]) if (obj.type === 3) objects.delete(oid);
  } else if (plan.filter === 'tree:0') {
    for (const [oid, obj] of [...objects]) if (obj.type === 2 || obj.type === 3) objects.delete(oid);
  }
  // Shallow lines: the new boundaries. Unshallow lines: old boundaries that
  // are now inside the fetched depth and no longer boundaries.
  const unshallow = plan.shallowOld.filter((old) => commits.includes(old) && !boundary.includes(old));
  return { objects, shallow: boundary, unshallow };
}

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const parts: Buffer[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(defaultRef);
  // The HEAD line obeys the same prefix filter as every other ref: with a
  // refs/heads/ prefix it is not returned, and with an unmatched prefix
  // nothing is returned at all.
  const headIncluded = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headIncluded) {
    if (tip === undefined) {
      // An unborn default branch: real git answers with an `unborn` line, not
      // a zero oid, so the client knows the repository is empty and does not
      // try to fetch the zero object id.
      if (unborn) parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}\n`));
      else parts.push(pktLine(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}\n`));
    } else {
      let headLine = `${tip} HEAD`;
      if (symrefs) headLine += ` symref-target:${defaultRef}`;
      parts.push(pktLine(`${headLine}\n`));
    }
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const oid = repo.refs.get(name) ?? ZERO_OID;
    let line = `${oid} ${name}`;
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 4) {
        const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (match) line += ` peeled:${match[1]}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV2Response(repo: Repo, args: string[]): Buffer {
  const plan: FetchPlan = { wants: [], haves: [], shallowOld: [] };
  for (const arg of args) {
    if (arg.startsWith('want ')) plan.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) plan.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) plan.shallowOld.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) plan.depth = parseInt(arg.slice(7).trim(), 10);
    else if (arg.startsWith('filter ')) plan.filter = arg.slice(7).trim();
  }
  const { objects, shallow, unshallow } = planFetch(repo, plan);
  const parts: Buffer[] = [];
  // The acknowledgments section only exists when the client sent haves: a
  // fetch with no haves goes straight to the packfile section. Sending an
  // acknowledgments section unconditionally makes a real git client fail
  // with "expected 'packfile', received 'acknowledgments'".
  if (plan.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.haves.every((have) => repo.objects.has(have))) {
      parts.push(pktLine(`ACK ${plan.haves[0]}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_DELIM);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(writePack(objects)));
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, lines: { kind: string; text: string }[]): Buffer {
  const plan: FetchPlan = { wants: [], haves: [], shallowOld: [] };
  for (const line of lines) {
    const text = line.text;
    if (text.startsWith('want ')) plan.wants.push(text.slice(5).trim().split(' ')[0]);
    else if (text.startsWith('have ')) plan.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) plan.shallowOld.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) plan.depth = parseInt(text.slice(7).trim(), 10);
  }
  const { objects, shallow, unshallow } = planFetch(repo, plan);
  const parts: Buffer[] = [];
  if (plan.haves.length > 0 && plan.haves.every((have) => repo.objects.has(have))) {
    parts.push(pktLine(`ACK ${plan.haves[0]}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sideband(writePack(objects)));
  return Buffer.concat(parts);
}

export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer, protocol2: boolean): HttpReply {
  const repo = store.resolve(owner, repoName);
  if (!repo) return notFound();
  const { lines } = parsePktLines(body);
  const dataLines = lines.filter((line) => line.kind === 'data').map((line) => line.text.replace(/\n$/, ''));
  if (dataLines.length === 0) return jsonReply(400, { message: 'empty upload-pack request' });
  if (protocol2) {
    const command = dataLines[0];
    const delimIndex = lines.findIndex((line) => line.kind === 'delim');
    const args = delimIndex === -1 ? dataLines.slice(1) : lines.slice(delimIndex + 1).filter((line) => line.kind === 'data').map((line) => line.text.replace(/\n$/, ''));
    if (command === 'command=ls-refs') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(repo, args) };
    }
    if (command === 'command=fetch') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2Response(repo, args) };
    }
    return jsonReply(400, { message: `unknown upload-pack command ${command}` });
  }
  // v0: wants, then a flush, then haves and done.
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0Response(repo, lines) };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): HttpReply {
  const repo = store.resolve(owner, repoName);
  if (!repo) return notFound();
  const { lines, rest } = parsePktLines(body);
  const commands: PushCommand[] = [];
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    const text = line.text.replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const head = nul === -1 ? text : text.slice(0, nul);
    const parts = head.split(' ');
    if (parts.length === 3 && isObjectId(parts[0]) && isObjectId(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  // The pack follows the command flush. A delete-only push carries none.
  const packBytes = body.subarray(rest);
  const incoming = new Map<string, { type: number; data: Buffer }>();
  if (packBytes.length > 0) {
    try {
      for (const [oid, obj] of readPack(packBytes)) incoming.set(oid, obj);
    } catch {
      return jsonReply(400, { message: 'could not read push pack' });
    }
  }
  const report: string[] = ['unpack ok\n'];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        report.push(`ng ${command.ref} ref does not exist\n`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.delete(command.ref);
        report.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    const newObj = incoming.get(command.newOid) ?? repo.objects.get(command.newOid);
    if (!newObj) {
      report.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    const isTagRef = command.ref.startsWith('refs/tags/');
    if (!isTagRef && newObj.type !== 1) {
      // A branch must point at a commit; a tag may point at any object
      // (an annotated tag points at a tag object, a lightweight tag at a
      // commit).
      report.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
    } else if (isTagRef) {
      if (command.oldOid === ZERO_OID) {
        report.push(`ng ${command.ref} already exists\n`);
        continue;
      }
      if (command.oldOid !== current) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
    } else if (command.oldOid !== current) {
      report.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    } else if (!isAncestor(repo, command.newOid, current) && !incomingHasAncestor(incoming, repo, command.newOid, current)) {
      report.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    for (const [oid, obj] of incoming) repo.objects.set(oid, obj);
    repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}\n`);
  }
  const reportBytes = Buffer.concat(report.map((line) => pktLine(line)));
  // The report-status stream is itself pkt-lined inside band 1, so its
  // terminating flush has to travel inside the band as well: the sideband
  // demultiplexer swallows the outer flush, and without an inner one a real
  // git client reads EOF where it expects the end of the report and dies
  // with "the remote end hung up unexpectedly".
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: sideband(Buffer.concat([reportBytes, PKT_FLUSH])) };
}

/** Ancestor check that also sees the objects the push just brought in. */
function incomingHasAncestor(
  incoming: Map<string, { type: number; data: Buffer }>,
  repo: Repo,
  tip: string,
  ancestor: string,
): boolean {
  if (tip === ancestor) return true;
  const seen = new Set<string>([tip]);
  const queue = [tip];
  for (let qi = 0; qi < queue.length; qi += 1) {
    const obj = incoming.get(queue[qi]) ?? repo.objects.get(queue[qi]);
    if (!obj || obj.type !== 1) continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- contents helpers (shared with REST)

export interface FileChange {
  path: string;
  content: Buffer;
}

/** Apply a set of file changes (path -> new blob bytes, or null to delete) to
 *  the tree at a commit and return the new tree oid, creating trees and blobs
 *  in the repo store as needed. */
export function applyTreeChanges(repo: Repo, baseCommitOid: string | null, changes: Map<string, Buffer | null>): string {
  const baseFlat = baseCommitOid === null ? new Map<string, { oid: string; mode: string }>() : flattenTreeLocal(repo, baseCommitOid);
  const flat = new Map(baseFlat);
  for (const [path, content] of changes) {
    if (content === null) flat.delete(path);
    else {
      const blobOid = objectId('blob', content);
      repo.objects.set(blobOid, { type: 3, data: content });
      flat.set(path, { oid: blobOid, mode: '100644' });
    }
  }
  return buildTreeFromFlat(repo, flat, '');
}

function flattenTreeLocal(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 1) return out;
  const walk = (treeOid: string, prefix: string): void => {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 2) return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(parseCommit(commit.data).tree, '');
  return out;
}

function buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>, prefix: string): string {
  const entries: { mode: string; name: string; oid: string }[] = [];
  const dirs = new Set<string>();
  for (const [path, value] of flat) {
    if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
    const rest = prefix === '' ? path : path.slice(prefix.length + 1);
    const slash = rest.indexOf('/');
    if (slash === -1) entries.push({ mode: value.mode, name: rest, oid: value.oid });
    else dirs.add(rest.slice(0, slash));
  }
  for (const dir of dirs) {
    const subPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
    const subTree = buildTreeFromFlat(repo, flat, subPrefix);
    entries.push({ mode: '40000', name: dir, oid: subTree });
  }
  const treeData = buildTree(entries);
  const treeOid = objectId('tree', treeData);
  repo.objects.set(treeOid, { type: 2, data: treeData });
  return treeOid;
}

/** Create a commit on a branch from a set of file changes. Returns the new
 *  commit oid, or null when the branch tip does not match the expected sha. */
export function commitChanges(
  repo: Repo,
  branch: string,
  message: string,
  changes: Map<string, Buffer | null>,
  expectedSha?: string,
): string | null {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (expectedSha !== undefined && tip !== expectedSha) return null;
  const treeOid = applyTreeChanges(repo, tip ?? null, changes);
  const parents = tip === undefined ? [] : [tip];
  const commitData = buildCommit(treeOid, parents, message);
  const commitOid = objectId('commit', commitData);
  repo.objects.set(commitOid, { type: 1, data: commitData });
  repo.refs.set(ref, commitOid);
  return commitOid;
}
