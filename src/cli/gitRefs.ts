// Branches and tags from `git ls-remote --heads --tags` output (no `vscode` import).
export type RemoteRefs = { branches: string[]; tags: string[] };

export function parseLsRemote(stdout: string): RemoteRefs {
	const branches = new Set<string>();
	const tags = new Set<string>();
	for (const line of stdout.split(/\r?\n/)) {
		const ref = line.split('\t')[1];
		if (ref?.startsWith('refs/heads/')) {
			branches.add(ref.slice('refs/heads/'.length));
		} else if (ref?.startsWith('refs/tags/')) {
			tags.add(ref.slice('refs/tags/'.length).replace(/\^\{\}$/, ''));
		}
	}
	return { branches: [...branches].sort(), tags: [...tags].sort().reverse() };
}
