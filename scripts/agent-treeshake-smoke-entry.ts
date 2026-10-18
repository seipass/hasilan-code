import { Agent } from "@hasilan-code/pi-agent-core";
import { createModels } from "@hasilan-code/pi-ai";
import { anthropicProvider } from "@hasilan-code/pi-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Anthropic smoke-test model not found");

export const agent = new Agent({
	initialState: { model },
	streamFn: models.streamSimple.bind(models),
});
