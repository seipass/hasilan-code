export const CHAT_MIN_WIDTH = 320;
export const CHAT_MAX_WIDTH = 3000;
/** Horizontal room kept around the column so its drag handle never sits under the window edge. */
export const CHAT_GUTTER = 56;

/**
 * A width saved on a wide window must stay resizable after the pane shrinks, otherwise the
 * drag handle is drawn at (or past) the pane edge and cannot be grabbed again.
 */
export function clampChatWidth(value: number, paneWidth: number): number {
	const upper =
		paneWidth > 0 ? Math.max(CHAT_MIN_WIDTH, Math.min(CHAT_MAX_WIDTH, paneWidth - CHAT_GUTTER)) : CHAT_MAX_WIDTH;
	return Math.round(Math.max(CHAT_MIN_WIDTH, Math.min(upper, value)));
}
