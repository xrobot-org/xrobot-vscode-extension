// Process execution for the XRobot/LibXR CLIs. No `vscode` import: unit-tested in plain Node.
//
// Rules (see README "How the extension runs the CLIs"):
// - never `shell: true`: every argument (JSON, C++ text, paths with spaces) reaches the
//   tool as one argv element;
// - executables are resolved here against PATH, so a missing tool is reported as such
//   instead of being guessed by a shell;
// - output is decoded as UTF-8 from the complete byte buffer (streamed output goes
//   through a StringDecoder), so multi-byte characters split across chunks survive.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export type ProcessResult = {
	// Exit code; null when the process could not start, was killed or was cancelled.
	code: number | null;
	stdout: string;
	stderr: string;
	// Set when the process could not be started (e.g. ENOENT, EACCES).
	error?: NodeJS.ErrnoException;
	cancelled: boolean;
};

export type ProcessRun = {
	done: Promise<ProcessResult>;
	cancel: () => void;
};

export type ProcessOptions = {
	cwd: string;
	env: NodeJS.ProcessEnv;
	onStdout?: (text: string) => void;
	onStderr?: (text: string) => void;
};

export function decodeUtf8(chunks: Buffer[]): string {
	return Buffer.concat(chunks).toString('utf8');
}

export function runProcess(command: string, args: string[], options: ProcessOptions): ProcessRun {
	let cancelled = false;
	let child: ReturnType<typeof spawn> | undefined;
	const done = new Promise<ProcessResult>((resolve) => {
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		const stdoutDecoder = new StringDecoder('utf8');
		const stderrDecoder = new StringDecoder('utf8');
		let settled = false;
		const settle = (code: number | null, error?: NodeJS.ErrnoException): void => {
			if (settled) {
				return;
			}
			settled = true;
			const tailOut = stdoutDecoder.end();
			const tailErr = stderrDecoder.end();
			if (tailOut) {
				options.onStdout?.(tailOut);
			}
			if (tailErr) {
				options.onStderr?.(tailErr);
			}
			resolve({
				code,
				stdout: decodeUtf8(stdoutChunks),
				stderr: decodeUtf8(stderrChunks),
				error,
				cancelled,
			});
		};
		try {
			child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true });
		} catch (error) {
			settle(null, error as NodeJS.ErrnoException);
			return;
		}
		child.stdout?.on('data', (chunk: Buffer) => {
			stdoutChunks.push(chunk);
			const text = stdoutDecoder.write(chunk);
			if (text) {
				options.onStdout?.(text);
			}
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderrChunks.push(chunk);
			const text = stderrDecoder.write(chunk);
			if (text) {
				options.onStderr?.(text);
			}
		});
		child.on('error', (error: NodeJS.ErrnoException) => settle(null, error));
		child.on('close', (code: number | null) => settle(code));
	});
	return {
		done,
		cancel: () => {
			cancelled = true;
			child?.kill();
		},
	};
}

export function pathKey(env: NodeJS.ProcessEnv): string {
	return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

export function splitPathList(value: string, platform: NodeJS.Platform = process.platform): string[] {
	const sep = platform === 'win32' ? ';' : ':';
	return value
		.split(sep)
		.map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
		.filter(Boolean);
}

// Resolves `name` to an absolute executable path using PATH from `env`. A name that
// contains a path separator is checked as given. On Windows only .exe/.com qualify:
// .bat/.cmd files need a shell, which is never used.
export function findExecutable(
	name: string,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	if (!name) {
		return undefined;
	}
	const pathApi = platform === 'win32' ? path.win32 : path.posix;
	const extensions = platform === 'win32' ? windowsExtensions(name) : [''];
	const candidates = (dir: string): string[] => extensions.map((ext) => pathApi.join(dir, name + ext));
	if (name.includes('/') || (platform === 'win32' && name.includes('\\'))) {
		return extensions.map((ext) => name + ext).find((candidate) => isExecutableFile(candidate, platform));
	}
	for (const dir of splitPathList(env[pathKey(env)] ?? '', platform)) {
		const found = candidates(dir).find((candidate) => isExecutableFile(candidate, platform));
		if (found) {
			return found;
		}
	}
	return undefined;
}

function windowsExtensions(name: string): string[] {
	return /\.(exe|com)$/i.test(name) ? [''] : ['.exe', '.com'];
}

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
	try {
		const stat = fs.statSync(candidate);
		if (!stat.isFile()) {
			return false;
		}
		if (platform !== 'win32') {
			fs.accessSync(candidate, fs.constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}

// The message a failed CLI run reports: XRobot prints its error on stderr and exits 1.
export function failureMessage(result: ProcessResult, command: string): string {
	if (result.cancelled) {
		return `${command} was cancelled`;
	}
	if (result.error) {
		return result.error.code === 'ENOENT' ? `${command} was not found` : `${command}: ${result.error.message}`;
	}
	const lines = result.stderr
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		// Warnings the tool prints before an error are not the error (English or Chinese output).
		.filter((line) => !/^(warning:|警告[:：])/i.test(line));
	if (lines.length > 0) {
		return lines[lines.length - 1];
	}
	return `${command} exited with code ${result.code ?? 'unknown'}`;
}
