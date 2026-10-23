export function FileIcon({ name }: { name: string }) {
	const lower = name.toLowerCase();
	const extension = lower.split(".").at(-1) ?? "";
	let kind = "file";
	let detail = "M8 14h8m-8 3h6";
	if (/^(png|jpe?g|gif|webp|svg|ico|avif|bmp)$/.test(extension)) {
		kind = "image"; detail = "m6 18 4-5 3 3 2-2 3 4M9 10h.01";
	} else if (/^(mp3|wav|ogg|flac|m4a|aac)$/.test(extension)) {
		kind = "audio"; detail = "M14 10v7a2 2 0 1 1-2-2h2m0-5 3-1v6";
	} else if (/^(mp4|webm|mov|mkv|avi)$/.test(extension)) {
		kind = "video"; detail = "m10 11 6 4-6 4z";
	} else if (/^(zip|gz|tar|7z|rar|bz2|xz)$/.test(extension)) {
		kind = "archive"; detail = "M11 9h2m-2 3h2m-2 3h2m-2 3h2";
	} else if (/^(json|jsonc|ya?ml|toml|ini|conf|lock)$/.test(extension) || /^(\.env|\.git|\.npm|\.editorconfig)/.test(lower)) {
		kind = "config"; detail = "M8 12h8m-8 5h8m-5-7v4m3 1v4";
	} else if (/^(md|mdx|txt|rst|pdf|docx?)$/.test(extension) || /^(readme|license|changelog)/.test(lower)) {
		kind = "document"; detail = "M8 10h4m-4 4h8m-8 3h8";
	} else if (/^(sh|bash|zsh|ps1|bat|cmd)$/.test(extension)) {
		kind = "script"; detail = "m8 11 3 3-3 3m5 0h3";
	} else if (/^(tsx?|jsx?|mjs|cjs|py|rs|go|java|c|cpp|h|cs|rb|php|swift|kt|html|css|scss|vue|svelte|nix)$/.test(extension)) {
		kind = "code"; detail = "m10 11-3 3 3 3m4-6 3 3-3 3";
	}
	return <svg className={`files-type-icon is-${kind}`} viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H5v18h14V8zM14 3v5h5" /><path d={detail} /></svg>;
}
