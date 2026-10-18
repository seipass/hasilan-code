import type { AccountUsageReader } from "../account-usage.ts";
import type { Provider } from "../models.ts";
import { commandCodeAccountUsage } from "./account-usage/commandcode.ts";

/** Recognize the actual endpoint, not a user-controlled provider display name. */
export function getAccountUsageReader(provider: Provider): AccountUsageReader | undefined {
	const commandCodeUrl = (value: string): boolean => {
		try {
			const url = new URL(value);
			return url.origin === "https://api.commandcode.ai" && !url.username && !url.password;
		} catch {
			return false;
		}
	};
	if (provider.baseUrl) {
		if (commandCodeUrl(provider.baseUrl)) return commandCodeAccountUsage;
	} else {
		const models = provider.getModels();
		if (models.length && models.every((model) => commandCodeUrl(model.baseUrl))) return commandCodeAccountUsage;
	}
	return provider.getAccountUsage;
}
