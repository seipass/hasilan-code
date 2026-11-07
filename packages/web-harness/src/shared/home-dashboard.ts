export interface GithubDashboard {
	state: "ready" | "unavailable";
	message?: string;
	login?: string;
	profileUrl?: string;
	contributions?: {
		total: number;
		weeks: { date: string; count: number; level: number }[][];
	};
	pullRequestCount?: number;
	pullRequests?: {
		title: string;
		url: string;
		number: number;
		repository: string;
		draft: boolean;
		updatedAt: string;
		review: string | null;
	}[];
	checkedAt: string;
}
