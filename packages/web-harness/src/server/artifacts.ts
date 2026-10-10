import { randomUUID } from "node:crypto";

export type ArtifactMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface ArtifactReference {
	id: string;
	url: string;
	mimeType: ArtifactMimeType;
	size: number;
}

export interface Artifact extends ArtifactReference {
	sessionId: string;
	agentId: string;
	bytes: Buffer;
}

export interface ArtifactInput {
	sessionId: string;
	agentId: string;
	bytes: Buffer;
	mimeType: ArtifactMimeType;
}

function matchesImageSignature(bytes: Buffer, mimeType: ArtifactMimeType): boolean {
	switch (mimeType) {
		case "image/png":
			return bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a;
		case "image/jpeg":
			return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
		case "image/webp":
			return (
				bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
			);
		case "image/gif": {
			if (bytes.length < 6) return false;
			const header = bytes.toString("ascii", 0, 6);
			return header === "GIF87a" || header === "GIF89a";
		}
	}
}

/** Launch-local artifacts only: active documents and host paths are never served. */
export class ArtifactStore {
	private readonly artifacts = new Map<string, Artifact>();

	put(input: ArtifactInput): ArtifactReference {
		if (!input.sessionId || !input.agentId) throw new Error("Artifacts require a session and agent owner");
		if (!matchesImageSignature(input.bytes, input.mimeType))
			throw new Error("Artifact MIME type does not match its image signature");
		const id = randomUUID();
		const reference: ArtifactReference = {
			id,
			url: `/api/artifacts/${id}`,
			mimeType: input.mimeType,
			size: input.bytes.length,
		};
		this.artifacts.set(id, {
			...reference,
			sessionId: input.sessionId,
			agentId: input.agentId,
			bytes: Buffer.from(input.bytes),
		});
		return reference;
	}

	get(id: string): Artifact | undefined {
		return this.artifacts.get(id);
	}

	deleteSession(sessionId: string): void {
		for (const [id, artifact] of this.artifacts) {
			if (artifact.sessionId === sessionId) this.artifacts.delete(id);
		}
	}

	close(): void {
		this.artifacts.clear();
	}
}
