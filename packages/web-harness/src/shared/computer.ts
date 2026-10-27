export interface ComputerStatus {
	ready: boolean;
	platform: string;
	error?: string;
	setup: string[];
}

export const COMPUTER_REQUIREMENTS = ["mss==10.2.0", "pynput==1.8.2"] as const;
