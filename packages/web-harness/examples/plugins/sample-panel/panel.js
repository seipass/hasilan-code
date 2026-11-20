document.currentScript.dispatchEvent(
	new CustomEvent("hasilan:panel", {
		detail(root, { workspaceId, insertDraft, signal }) {
			const wrap = document.createElement("section");
			wrap.style.cssText = "padding: 20px; display: grid; gap: 12px; max-width: 560px;";
			const heading = document.createElement("h2");
			heading.textContent = "サンプルパネル";
			const note = document.createElement("textarea");
			note.rows = 4;
			note.placeholder = "メモを入力してチャットの下書きへ送れます";
			const send = document.createElement("button");
			send.type = "button";
			send.textContent = "下書きに追加";
			send.addEventListener(
				"click",
				() => {
					const text = note.value.trim() || `ワークスペース ${workspaceId} のメモ`;
					insertDraft(text);
				},
				{ signal },
			);
			wrap.append(heading, note, send);
			root.append(wrap);
			return () => {
				wrap.remove();
			};
		},
	}),
);
