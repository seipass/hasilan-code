export interface ArchivedSession {
	file: string;
	sessionId: string;
	cwd: string;
	title?: string;
	modifiedAt: number;
	bytes: number;
}
