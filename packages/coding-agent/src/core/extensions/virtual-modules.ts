import * as bundledPiAgentCore from "@hasilan-code/pi-agent-core";
import * as bundledPiAiModels from "@hasilan-code/pi-ai/models";
import * as bundledPiAiOauth from "@hasilan-code/pi-ai/oauth";
import * as bundledPiAiProviders from "@hasilan-code/pi-ai/providers/all";
import * as bundledPiTui from "@hasilan-code/pi-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @hasilan-code/pi-coding-agent.
import * as bundledPiCodingAgent from "../../index.ts";
import * as bundledPiAiExtensionView from "./pi-ai-extension-view.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@hasilan-code/pi-agent-core": bundledPiAgentCore,
	"@hasilan-code/pi-tui": bundledPiTui,
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint) plus TypeBox's Type, Static and TSchema:
	// existing extensions using the old global API and pi-ai's former TypeBox
	// re-exports keep working.
	"@hasilan-code/pi-ai": bundledPiAiExtensionView,
	"@hasilan-code/pi-ai/compat": bundledPiAiExtensionView,
	"@hasilan-code/pi-ai/models": bundledPiAiModels,
	"@hasilan-code/pi-ai/oauth": bundledPiAiOauth,
	"@hasilan-code/pi-ai/providers/all": bundledPiAiProviders,
	"@hasilan-code/pi-coding-agent": bundledPiCodingAgent,
	"@mariozechner/pi-agent-core": bundledPiAgentCore,
	"@mariozechner/pi-tui": bundledPiTui,
	"@mariozechner/pi-ai": bundledPiAiExtensionView,
	"@mariozechner/pi-ai/compat": bundledPiAiExtensionView,
	"@mariozechner/pi-ai/models": bundledPiAiModels,
	"@mariozechner/pi-ai/oauth": bundledPiAiOauth,
	"@mariozechner/pi-ai/providers/all": bundledPiAiProviders,
	"@mariozechner/pi-coding-agent": bundledPiCodingAgent,
};
