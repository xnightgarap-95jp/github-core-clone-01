// Git object model, pkt-lines and packfiles, implemented from the wire
// format. No git binary, no child processes: everything is node:crypto and
// node:zlib over Buffers.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, Repo } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export const TYPE_NAMES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export const TYPE_NUMBERS: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function objectId(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim' | 'end';
export interface PktLineParsed {
  kind: PktKind;
  text: string;
}

/** Parse pkt-lines from the start of a buffer. Stops after the first flush
 *  (or at the end of the buffer) and reports where the stream ended, so the
 *  caller can read the raw bytes that follow (a packfile). */
export function parsePktLines(buf: Buffer): { lines: PktLineParsed[]; rest: number } {
  const lines: PktLineParsed[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      lines.push({ kind: 'flush', text: '' });
      off += 4;
      break;
    }
    if (len === 1) {
      lines.push({ kind: 'delim', text: '' });
      off += 4;
      continue;
    }
    if (len === 2) {
      lines.push({ kind: 'end', text: '' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    lines.push({ kind: 'data', text: buf.subarray(off + 4, off + len).toString('utf8') });
    off += len;
  }
  return { lines, rest: off };
}

/** Wrap raw bytes in sideband packets (band 1 = pack data). Each packet is
 *  one pkt-line whose first payload byte is the band number. */
export function sideband(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const maxPayload = 65515; // 65520 max pkt-line, minus 4 header, minus 1 band byte
  for (let off = 0; off < data.length; off += maxPayload) {
    const slice = data.subarray(off, Math.min(off + maxPayload, data.length));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    chunks.push(Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'ascii'), payload]));
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- objects

export interface CommitParsed {
  tree: string;
  parents: string[];
  message: string;
}

export function parseCommit(data: Buffer): CommitParsed {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space === -1) break;
    const mode = data.subarray(off, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries compare by name, with directories compared as if
 *  their name had a trailing slash. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  const key = (entry: TreeEntry): string => (entry.mode === '40000' ? `${entry.name}/` : entry.name);
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Fixed author/committer stamp: the state export must not depend on wall
 *  time, so server-made commits always carry epoch 0. */
const FORGE_IDENT = 'Forge <forge@forge.local> 0 +0000';

export function buildCommit(tree: string, parents: string[], message: string): Buffer {
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${FORGE_IDENT}\ncommitter ${FORGE_IDENT}\n\n${message}`;
  return Buffer.from(text, 'utf8');
}

export function buildTag(object: string, type: string, tag: string, message: string): Buffer {
  const text = `object ${object}\ntype ${type}\ntag ${tag}\ntagger ${FORGE_IDENT}\n\n${message}`;
  return Buffer.from(text, 'utf8');
}

// ---------------------------------------------------------------- packs

function readObjectHeader(buf: Buffer, off: number): { type: number; size: number; next: number } {
  const first = buf[off];
  const type = (first >> 4) & 0x7;
  let size = first & 0x0f;
  let shift = 4;
  let i = off + 1;
  let byte = first;
  while (byte & 0x80) {
    byte = buf[i];
    size |= (byte & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { type, size, next: i };
}

function encodeObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (type << 4) | (remaining & 0x0f);
  remaining >>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Inflate the zlib stream at `off`. inflateSync ignores trailing bytes but
 *  throws on a truncated stream, so the stream end is found by binary search
 *  for the smallest slice that inflates to exactly the expected size. */
function inflateAt(buf: Buffer, off: number, expectedSize: number): { data: Buffer; next: number } {
  let lo = off + 1;
  let hi = buf.length;
  let best = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    let data: Buffer | null = null;
    try {
      data = inflateSync(buf.subarray(off, mid));
    } catch {
      data = null;
    }
    if (data !== null && data.length === expectedSize) {
      best = mid;
      hi = mid - 1;
    } else if (data !== null && data.length > expectedSize) {
      best = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (best === -1) throw new Error('could not inflate pack object');
  return { data: inflateSync(buf.subarray(off, best)), next: best };
}

function readDeltaVarint(delta: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = off;
  let byte = 0;
  do {
    byte = delta[i];
    value |= (byte & 0x7f) << shift;
    shift += 7;
    i += 1;
  } while (byte & 0x80);
  return { value, next: i };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const source = readDeltaVarint(delta, off);
  off = source.next;
  const target = readDeltaVarint(delta, off);
  off = target.next;
  if (source.value !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          copyOff |= delta[off] << (8 * i);
          off += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          copySize |= delta[off] << (8 * i);
          off += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOff, copyOff + copySize));
    } else if (op !== 0) {
      parts.push(delta.subarray(off, off + op));
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(parts);
  if (result.length !== target.value) throw new Error('delta target size mismatch');
  return result;
}

/** Read a packfile into objects keyed by oid. Handles plain objects and
 *  OFS_DELTA / REF_DELTA entries. */
export function readPack(buf: Buffer): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = buf.readUInt32BE(8);
  const entries = new Map<string, GitObject>();
  const byOffset = new Map<number, string>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    const header = readObjectHeader(buf, off);
    off = header.next;
    let baseOid: string | null = null;
    let baseOffset = -1;
    if (header.type === 6) {
      // OFS_DELTA: negative offset varint.
      let byte = buf[off];
      off += 1;
      let negOff = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[off];
        off += 1;
        negOff = ((negOff + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - negOff;
      baseOid = byOffset.get(baseOffset) ?? null;
    } else if (header.type === 7) {
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const inflated = inflateAt(buf, off, header.size);
    off = inflated.next;
    if (header.type === 6 || header.type === 7) {
      const base = baseOid !== null ? entries.get(baseOid) : undefined;
      if (!base) throw new Error('delta base missing from pack');
      const data = applyDelta(base.data, inflated.data);
      const oid = objectId(TYPE_NAMES[base.type], data);
      entries.set(oid, { type: base.type, data });
      byOffset.set(start, oid);
    } else {
      const typeName = TYPE_NAMES[header.type];
      if (!typeName) throw new Error(`unknown pack object type ${header.type}`);
      const oid = objectId(typeName, inflated.data);
      entries.set(oid, { type: header.type, data: inflated.data });
      byOffset.set(start, oid);
    }
  }
  return entries;
}

/** Write a packfile of plain (non-delta) objects. Deltas are never needed:
 *  a client accepts a pack that simply lists every object it asked for. */
export function writePack(objects: Map<string, GitObject>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.size, 8);
  parts.push(header);
  const sorted = [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [, obj] of sorted) {
    parts.push(encodeObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- walking

export interface WalkResult {
  commits: string[];
  boundary: string[];
}

/** Walk parents from the tips. Tips are depth 1; a commit at the depth limit
 *  is a shallow boundary and its parents are not followed. */
export function walkCommits(repo: Repo, tips: string[], depth?: number): WalkResult {
  const depthOf = new Map<string, number>();
  const queue: string[] = [];
  for (const tip of tips) {
    if (!depthOf.has(tip)) {
      depthOf.set(tip, 1);
      queue.push(tip);
    }
  }
  const commits: string[] = [];
  const boundary: string[] = [];
  for (let qi = 0; qi < queue.length; qi += 1) {
    const oid = queue[qi];
    const d = depthOf.get(oid) ?? 1;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 1) continue;
    commits.push(oid);
    if (depth !== undefined && d >= depth) {
      boundary.push(oid);
      continue;
    }
    for (const parent of parseCommit(obj.data).parents) {
      if (!depthOf.has(parent)) {
        depthOf.set(parent, d + 1);
        queue.push(parent);
      }
    }
  }
  return { commits, boundary };
}

/** Every object reachable from the given commits: the commits themselves plus
 *  their trees and blobs, recursively. */
export function collectObjects(repo: Repo, commits: string[]): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const addTree = (treeOid: string): void => {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 2 || out.has(treeOid)) return;
    out.set(treeOid, tree);
    for (const entry of parseTree(tree.data)) {
      const child = repo.objects.get(entry.oid);
      if (!child) continue;
      if (entry.mode === '40000') addTree(entry.oid);
      else out.set(entry.oid, child);
    }
  };
  for (const oid of commits) {
    const commit = repo.objects.get(oid);
    if (!commit || commit.type !== 1 || out.has(oid)) continue;
    out.set(oid, commit);
    addTree(parseCommit(commit.data).tree);
  }
  return out;
}

/** Is `ancestor` reachable from `tip` by following parents? */
export function isAncestor(repo: Repo, tip: string, ancestor: string): boolean {
  if (tip === ancestor) return true;
  const seen = new Set<string>([tip]);
  const queue = [tip];
  for (let qi = 0; qi < queue.length; qi += 1) {
    const obj = repo.objects.get(queue[qi]);
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

/** The merge-base of two commits: the first common ancestor found by a
 *  breadth-first walk from both sides. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const fromA = new Map<string, number>();
  const queueA = [a];
  fromA.set(a, 0);
  for (let qi = 0; qi < queueA.length; qi += 1) {
    const obj = repo.objects.get(queueA[qi]);
    if (!obj || obj.type !== 1) continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!fromA.has(parent)) {
        fromA.set(parent, (fromA.get(queueA[qi]) ?? 0) + 1);
        queueA.push(parent);
      }
    }
  }
  const queueB = [b];
  const seenB = new Set<string>([b]);
  let best: string | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (let qi = 0; qi < queueB.length; qi += 1) {
    const oid = queueB[qi];
    const depthA = fromA.get(oid);
    if (depthA !== undefined && depthA < bestDepth) {
      best = oid;
      bestDepth = depthA;
    }
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 1) continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!seenB.has(parent)) {
        seenB.add(parent);
        queueB.push(parent);
      }
    }
  }
  return best;
}

/** Flat map of path -> { oid, mode } for the tree at a commit. */
export function flattenTree(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
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
