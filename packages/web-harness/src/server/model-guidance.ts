/** Additional workflow guidance for OpenAI coding models, including compatible gateways. */
export function modelGuidance(modelId: string | undefined): string[] {
	if (!modelId || !/^(?:openai\/)?(?:gpt-|codex(?:-|$))/i.test(modelId)) return [];
	return [
		"For a request to change code, inspect the relevant implementation first, then implement and run appropriate checks within the user's and project's instructions.",
		"For a question or discussion, answer it without editing files unless the user asks for changes.",
		"Report what was verified and distinguish unverified behavior from confirmed results.",
	];
}
