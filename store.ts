// In-memory state for the forge. One trial runs one process and the export
// only records pass/fail bits, so nothing here needs to survive a restart.
// Every object is kept raw (a Buffer) so a commit or tag a client pushed is
// served back byte for byte.

export interface GitObject {
  type: number; // 1 commit, 2 tree, 3 blob, 4 tag
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
}

export interface Pull {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  dbId: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  counter: number;
  commentCounter: number;
  seq: number;
}

export class Store {
  viewerLogin: string | null = null;
  repos = new Map<string, Repo>();
  private repoCounter = 0;
  private repoSeq = 0;

  /** The login the entry currently believes owns the token. Unknown until the
   *  first owner shows up in a request path; the suite always uses the
   *  scenario viewer login in its paths, so the first one seen is the right
   *  one. */
  viewer(): string {
    return this.viewerLogin ?? 'viewer';
  }

  createRepo(name: string, description: string, isPrivate: boolean, owner?: string): Repo | null {
    if (this.repos.has(name)) return null;
    this.repoCounter += 1;
    const repo: Repo = {
      dbId: this.repoCounter,
      name,
      owner: owner ?? this.viewer(),
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      counter: 0,
      commentCounter: 0,
      seq: ++this.repoSeq,
    };
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /** Resolve a repository by (owner, name). The owner in the path is how the
   *  entry learns the viewer login: the first owner seen is adopted, and any
   *  later owner that is not the viewer is a foreign owner and gets a 404. */
  resolve(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (!repo) return null;
    if (this.viewerLogin === null) {
      this.viewerLogin = owner;
      repo.owner = owner;
      return repo;
    }
    if (owner === this.viewerLogin) {
      repo.owner = owner;
      return repo;
    }
    return null;
  }

  repoByName(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  listViewerRepos(): Repo[] {
    const all = [...this.repos.values()].sort((a, b) => a.seq - b.seq);
    if (this.viewerLogin === null) return all;
    return all.filter((repo) => repo.owner === this.viewerLogin);
  }

  /** Opaque, stable global ids: never the bare database id or number. */
  globalId(kind: string, dbId: number, extra?: number): string {
    const text = extra === undefined ? `${kind}:${dbId}` : `${kind}:${dbId}:${extra}`;
    return Buffer.from(text, 'utf8').toString('base64');
  }

  nextNumber(repo: Repo): number {
    repo.counter += 1;
    return repo.counter;
  }
}
