# Pi Web Harness

## Context

`https://github.com/earendil-works/pi` を土台としてフォークし、ローカルWebサーバーとブラウザーUIから操作するAIハーネスを作る。必須機能は、動的エージェントチームとその可視化、内蔵Playwright Browser use、設定で切り替える複数Web検索、独自実装のHashline読み書き、ファイルビューア、ユーザー操作のPTY、複数セッションの同時実行と切り替え。oh-my-piのコードはコピー・移植・依存として使用しない。参考リポジトリの内部構造やWeb体験の再現は要求ではなく、このアプリの責務から設計する。

## Grounded baseline

- 作業ディレクトリは空。このセッションで確認済み。フォーク元のベースを `c5f5b3282d5e4203c085e59837ba17aeaf2829b5` に固定する。[revision](https://api.github.com/repos/earendil-works/pi/commits/main)
- PiはMIT、Node.js 22.19以上、npm workspaces。公開SDKは `createAgentSession(options): Promise<{session, extensionsResult, modelFallbackMessage?}>`。`tools?: string[]` は名前指定、実装は `customTools?: ToolDefinition[]`。同名のcustom toolはbuiltinを置換する。[SDK source](https://github.com/earendil-works/pi/blob/c5f5b3282d5e4203c085e59837ba17aeaf2829b5/packages/coding-agent/src/core/sdk.ts)
- 現行PiにWeb UI workspaceはない。実験的 `packages/server` はUnixソケットのルーターで、このWindows対応Webアプリの土台には使わない。[packages](https://api.github.com/repos/earendil-works/pi/contents/packages?ref=c5f5b3282d5e4203c085e59837ba17aeaf2829b5) / [server](https://github.com/earendil-works/pi/blob/c5f5b3282d5e4203c085e59837ba17aeaf2829b5/packages/server/README.md)
- DeepSeek HarnessはループバックWebサーバー、チャット・履歴・設定・ツール詳細を持つ。ローカルでも認証とHost/Origin検査を行う。[reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/README.md)
- oh-my-piのHashlineは行ごとのハッシュではない。全文由来の4桁タグ `[PATH#TAG]` と `LINE:TEXT`、`PUT` / `CUT` / `REM` / `MV` を使う。[format reference](https://github.com/can1357/oh-my-pi/blob/8d95cc008233d8526816d2afc775e96257c2c323/packages/hashline/src/format.ts) / [grammar reference](https://github.com/can1357/oh-my-pi/blob/8d95cc008233d8526816d2afc775e96257c2c323/packages/hashline/src/grammar.lark)。ユーザー指定に従い形式の参考だけにし、ソース・パッケージ・native binary・prompt・test fixtureを流用しない。

## Approach

### 責務と依存方向

新規アプリは一つのworkspaceに収め、サービスの境界だけを分ける。独立したplugin framework、DI container、第二のagent loopは作らない。

- `WorkspaceFiles` はworkspace内path解決、ファイル取得、revision検査、host共通mutation gateを所有する。Hashlineとファイルビューアはこれを呼び、Hashline parser自身はfilesystemやHTTPを知らない。
- `SessionRegistry` はPiの会話と実行adapterを所有する。`TeamManager` はagent所属、run、admission、通信・待機・停止を唯一所有し、会話を保存しない。
- `TerminalManager` はユーザーPTYのprocessとbufferを所有する。agentのbashと別物にし、会話やteam停止にPTYの寿命を結合しない。
- `BrowserManager` はagent用Playwright contextとtab、search adaptersは外部検索APIだけを所有する。
- HTTP/WSは上記サービスへの薄いadapter、Reactはserver snapshotの表示とcommand送信に限定する。activeSessionIdはブラウザーの表示状態であり、hostの実行対象を切り替えるsingletonにしない。
- 依存順は基盤とworkspace files → sessions/transport → teams、browser、search、PTY（独立に実装可能）→ UI統合。ファイルビューアはworkspace files後に実装可能。


### フォークとWebアプリの実行境界

1. 空の作業ディレクトリに `git clone https://github.com/earendil-works/pi.git .`、上記コミットから作業ブランチ `web-harness` を作る。originはフォーク先URLが未提供なのでupstreamとして保持し、GitHub上のリポジトリ作成やpushは行わない。まず実際の `AGENTS.md` を読み、規約に従う。
2. 新規workspace `packages/web-harness`、package名 `@hasilan/pi-web-harness` を追加する。TypeScript ESM、Node >=22.19、React + Viteのクライアント、Node `http` + `ws` のホスト、TypeBoxによる入力検証、Vitestを使う。既存npm workspaces・TypeScript/Vitest alias・固定版依存の規約に合わせる。現行に同等Webアプリはないため新設する。上流のcore、CLI、TUIを削除せず、Webアプリを独立した利用入口にする。
3. 新規 `src/server/`、`src/client/`、`src/shared/contracts.ts`、`test/` をこのworkspace内に作る。workspaceの `build` はserverのtsc出力とViteの静的bundle、`start` は `node dist/server/main.js`、`test` は `vitest --run`。rootに `web` = `npm run start --workspace=@hasilan/pi-web-harness --` を追加し、root build/build:offlineのcoding-agent後にWebのbuildを追加する。
4. `npm run web -- --no-open --port 3080 --cwd <workspace>` で起動する。既定は127.0.0.1:3080、cwdは起動ディレクトリ。`--port 0` はOS割当を許可し、確定URLを出力する。既定ではブラウザーをOS別の実コマンドで開く。`--no-open` またはSSH環境ならURLだけ出力。非loopbackへのbindは提供しない。port衝突・存在しないcwdは起動エラーとして終了し、別portやcwdへ黙って切り替えない。
5. 起動ごとに256bitのlaunch tokenを生成する。`/?token=...` を認証cookieへ交換し、tokenのないURLへredirectする。cookieはHttpOnly、SameSite=Strict、Path=/。API、WebSocket、artifactにはcookie認証を必須にする。Hostは設定済みloopback host/port、変更APIとWebSocket Originは実際のサーバーoriginのみ許可する。CORSは開かない。秘密・launch tokenを通常ログやイベントに出さない。静的UIだけ取得できても操作APIにはアクセスできない構成にする。

### 共通ファイルサービスとファイルビューア

1. 新規 `src/server/workspace-files.ts` に `WorkspaceFiles` を実装する。`list(workspaceId:string,path:string): Promise<FileEntry[]>`、`read(workspaceId:string,path:string): Promise<FileSnapshot>`、`commit(workspaceId:string,changes:FileChange[]): Promise<CommitResult>`、`create(workspaceId:string,path:string,content:Buffer): Promise<FileSnapshot>` を提供する。FileEntryは `{name,path,kind:'file'|'directory'|'symlink',size}`、FileSnapshotは `{path,bytes,revision}`、revisionはraw bytesのSHA-256。FileChangeは `{path,expectedRevision,beforeBytes,afterBytes,operation:'update'|'delete'|'move',moveDest?}`、CommitResultはfile別の適用結果を持つ。Hashline snapshotはこの取得結果を使い、別のfilesystem implementationを持たない。
2. workspace登録はrealpathでcanonicalizeし同rootの別aliasには同IDを返す。pathはworkspace-relativeでabsolute/drive-relative/UNC/device/colon(ADS)/NUL/`..` escapeを拒否。既存はrealpath、新規は最寄りexisting ancestorでworkspace内を検査し、path.relativeでcontainmentを判定する。root delete/moveは拒否。case-insensitive Windows/junctionも検証する。一階層directories-first/name順、hiddenも一覧、外部symlinkは表示だけ。overlapping rootを含めて安全にserializeするためmutation gateはhost全体で一つだけにし、workspaceId別queueを作らない。shell/external writerとのtransactionとは称さない。
3. `/api/workspaces/:id/files?path=` GETは一覧、`/api/workspaces/:id/file?path=&offset=&limit=` GETは `{path,revision,kind:'text'|'image'|'binary',lines?,nextOffset?,size}`。textはUTF-8、既定200行/最大64KiB、空fileは空lines、EOFはnextOffsetなし。PNG/JPEG/WebP/GIFは拡張子でなくsignature/MIMEを確認し10MiB以下を認証付き `/api/workspaces/:id/file-content?path=&revision=` から返す。revision違いは409、SVG/HTMLはtext、binaryはmetadata。Content-Type、nosniff、private/no-storeを設定しactive documentとして配信しない。
4. 新規 `src/client/files/` に折りたたみfile treeとread-only viewerを作る。textは行番号付きのescaped text、画像は上記URLのimg、binaryはmetadata。toolのpath/lineリンクから同じviewerを開き指定行へスクロールする。編集フォームや第二のeditor engineは追加しない。UIのファイル閲覧でagentのseenLinesを増やさない。
5. file treeとviewerにRefreshを付ける。アプリ内commit成功でworkspace通知 `{type:'files_changed',workspaceId,paths}` を送り、開いているfileと該当directoryを再取得する。PTYや外部editorの変更はRefreshで取得し、表示にrevisionを持つ。portable watcher/reconciliation systemを新設しない。ブラウザーが保持する内容をagentの編集preimageに転用しない。

### 永続セッションとWeb transport

1. 新規 `src/server/session-registry.ts` に `SessionRegistry` を実装する。sessionIdはPiの永続会話IDで、各IDに一つの `AgentSession` / `SessionManager`、同時に一つの未settle実行だけを持つ。`createAgentSession({cwd, modelRuntime, sessionManager, settingsManager, resourceLoader, customTools})`、`await resourceLoader.reload()`、`await session.bindExtensions({})`、prompt前のsubscribeを使う。loader/settingsは別々、model catalog/authはhost-owned `ModelRuntime.create()` を共有する。選択画面変更でSDKのswitchSessionを呼ばない。
2. Pi会話は `SessionManager.create(cwd,sessionDir,{id,parentSession})` / `open(path)` で保存。agentDir/web-harness/state.jsonにschemaVersion=1、canonical workspace、sessionId/path/materialized、子のrole/systemPrompt/model/tools、team/agent/run、pendingInputを保存する。state保存は単一queueとtemporary file rename。会話はPi JSONLだけがauthority。未使用sessionはJSONL未作成が正常なのでmaterialized=falseを保存し、再起動時は同ID/launch descriptorで再作成する。materialized=trueのfileが消えたらmissing表示し、openで無言再作成しない。壊れたstateはエラー、無言初期化で消さない。
3. APIは `/api/workspaces` GET/POST、`/api/sessions?workspaceId=` GET、`/api/sessions` POST `{workspaceId}`、`/api/sessions/:id` GET、`/api/sessions/:id/prompt` POST `{text,mode:'prompt'|'steer'|'followUp'}`、`/api/sessions/:id/abort` POST。HTTP commandは後述TeamManagerの一つのadmission経路へ渡す。通常promptのbusy競合は409、idle promptはrunIdを割当、steer/followUpは現runへの入力。応答は `{runId,disposition:'queued'|'started'}` で完了ではない。非同期preflight失敗も観測してrunをfailedへsettleする。model未設定は設定error。
4. `/api/events` WebSocketは `{type:'subscribe',subscriptionId,channel:'workspace'|'session',id}` / `{type:'unsubscribe',subscriptionId}`。workspaceは全session/team summary、sessionは会話/実行詳細。応答は `{type:'snapshot',subscriptionId,channel,id,epoch,seq,data}`、deltaは同identityにevent。epochはhost起動UUID、seqはchannel単調値。serverのin-memory projectionから同一同期区間でimmutable snapshot Sを採取し、その後S+1からeventを送る。clientは現在subscriptionId/epochだけ適用し、duplicateは捨て、欠落で再subscribe。旧sessionの遅延snapshotを選択中sessionへ混ぜない。失敗POSTを自動再送しない。WS queueが2MiBを超えるclientだけcloseし、agentは継続する。
5. projectionは初期Pi履歴から作り、message_update/message_end/tool/queue/retry/compaction/agent_settledを同期反映する。message_end callback内でSessionManagerから履歴を再構築しない（SDKのappendより通知が先の場合がある）。live messageIdをhostで割当、tool keyはsessionId/runId/callId。finalでpartialを置換し二重表示しない。会話はprojectionの別ディスク保存をしない。agent_endをidleとせずagent_settledを実行境界にする。host shutdownはadmission停止→全run cancel→idle待ち→browser/PTY/session/HTTP/WSをclose。

### 動的エージェントチームと実行管理

1. 新規 `src/server/team-manager.ts` に `TeamManager` を実装する。sessionは会話、agentは安定したteam所属、runは一回の実行として分ける。root sessionごとに永続teamId/root agentIdを持ち、別root sessionは独立teamで同時実行可能。agentは `{agentId,teamId,parentAgentId?,sessionId,name,role}`、runは `{runId,agentId,task,status,result?,error?,waitingOnRunIds?,startedAt?,settledAt?}`。statusは `queued|running|waiting|cancelling|completed|failed|cancelled|interrupted`。同agentを再開しても旧run/resultを書き換えない。
2. `SessionRegistry` はPi実行と会話projectionのみ、TeamManagerがrun/admission/schedulerを唯一所有する。TeamManagerからregistryを呼び、registryのsettlement通知を受ける。一つのteam-specific schedulerへroot prompt、spawn、idle宛send、再開を全て通す。session busy中のsteer/followUpは現runへ。runはagent_settledまでのretry/compaction/入力continuationを含む。abortedはcancelled、最後の未回復errorはfailed、それ以外completed。resultは現runの最終assistant textだけ。run settlementを永続化してからwaiterへ通知する。
3. 全agentへ `team` toolを `executionMode:'sequential'` で提供する。契約:
   - `{action:'spawn',tasks:[{name,task,context?,systemPrompt?,model?:{provider,id},tools?:string[]}]} → {agents:[{agentId,sessionId,runId,name,status}]}`。
   - `{action:'list'} → {agents:[{agentId,parentAgentId?,sessionId,name,currentRun?,latestRun?}]}`。
   - `{action:'send',agentId,message} → {inputId,runId,disposition:'queued'|'started'}`。
   - `{action:'wait',agentIds:string[],timeoutMs?:number} → {runs:[{agentId,runId,status,result?,error?}],timedOut:boolean}`。
   - `{action:'stop',agentId} → {status:'cancelling'|'cancelled'}`。
4. spawnはUUIDとinitial runを永続化後queueへ入れて即応答。子は独立 `SessionManager.create()` / `AgentSession`、parentSessionは親file、親履歴全体をforkしない。task/context/roleを指定する別loaderを作る。モデル未指定は親、tools未指定は親の有効集合、明示toolsは部分集合に限定。同workspaceの親子はlive fileを共有し、worktree/merge層を勝手に追加しない。`teams.maxDepth` 既定3（1..8）はroot depth=0から数える。
5. `teams.maxConcurrentAgents` はteamごとの「waitingでないadmitted run数」、rootも数える。既定4、1..32、FIFO。waitは対象agentのcurrent runまたはlatest terminal runを同期的にpinし、runなし/self/祖先/cycleを拒否する。terminal targetだけなら即応答。未完了があればdependency/listenerを登録しcallerをwaitingへ移しpermitを返す。全対象settleまたはtimeout（既定30秒、最大300秒）でdependencyを除きcallerをFIFOへ戻し、permitを再取得してからtoolを返す。AbortSignalでは再取得せず解除。permit release/settlementはidempotent。sequential tool batchでない場合にこのpermit解放方式を使わない。limit=1の親→子→孫のwaitでもqueued子が進む。
6. sendは同teamのみ許可。inputId付きpendingInputを保存してから受理し、queued recipientはhost inboxで保持しinitial prompt開始後にFIFOでfollowUpへ渡す。running/waitingにはfollowUp、idleは新run admissionへ。送信textは `[Team message inputId=<UUID> from=<agentId>]\n<message>` とし、Piのuser message_endでこのIDを照合してpendingを消す。待機中の相手を即割り込み処理するとは称さない。未消費入力はrestart後undeliveredとして表示し自動再送しない。ユーザーのsteer/followUpもpending stateへ保存するが、本文にteam markerは加えずhost側FIFOの消費対応で管理する。
7. agentのstopはself/祖先を拒否して自己待ちを避ける。ユーザーStopはrootなら全team、子ならそのsubtree。同期transitionで対象をspawn/send/admissionからfenceしqueuedをcancel、全running/waiting descendantへ先にcancelをsignal、host pending inputとPi queueをclear。その後lock外で全idleを並列に待ちcancelledを返す。stop完了後は新しい明示入力で新runを許可しfenceを解除。旧completed runは保持。restart時の非terminal runはinterruptedへ変更し自動再実行しない。

### oh-my-pi方式の独自Hashline

1. 新規 `src/server/tools/hashline/` に独自parser、snapshot store、applier、block resolverを実装し、customToolsの `read` / `edit` / `write` としてWebの親子全callerに渡す。上流のoldText/newText editはWebロードアウトに残さない。既存SDK `ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx)` とTypeBoxを使う。oh-my-pi由来のコードや依存は追加しない。公開文法の仕様から独立に実装し、自作fixtureで振る舞いを検証する。
2. `read({path:string,offset?:number,limit?:number})` は1-based offset既定1、limit既定200でテキストを返す。取得は `WorkspaceFiles.read()` を使い、全文からBOMを取り除きLFに正規化、`text.replace(/[ \t\r]+(?=\n|$)/g,'')` のUTF-8をxxHash32 seed=0で計算し、low16をuppercase 4桁とする。Hashlineは独自実装だが汎用hashまで再発明せず、oh-my-piと無関係な `xxhashjs` の `h32(Buffer.from(text,'utf8'),0).toNumber()` を使う。[API](https://github.com/pierrec/js-xxhash)。本文は `[relativePath#TAG]` と `N:TEXT`。完全に返した行だけをsession別snapshotのseenLinesへ追加し、全文ではなくwindowをhashしない。UTF-8でないbinaryはHashline対象外としてエラー、画像はPi既存read実装へ委譲してImageContentを保持、directoryは一覧を返しsnapshotにしない。不存在・不正offset/limitは明示エラー。最大64KiBで行単位に打ち切り、続きoffsetを返す。切れた行をseen扱いしない。snapshotはraw revision、BOM、改行形式、末尾改行も保持し、編集時は元のBOMと改行形式を維持する。mixed EOLは `Mixed line endings; normalize the file before editing` で拒否し、黙って全文を整形しない。
3. `edit({input:string})` は固定参考grammarの `*** Begin Patch` / `*** End Patch`、`[PATH#TAG]`、`PUT N.=M:`、`PUT N*:`、`PUT <N:` / `>N:` / `>N*:` / `>$:`、`CUT N.=M` / `N*`、名前付き/匿名registerのCUT/PUT、`REM`、`MV DEST` を実装する。行番号は入力snapshotに対する番号で、先行hunkでずらさない。bodyの `+` を一文字だけ除き、blank lineも保持する。範囲外・重複する破壊hunk・未定義register・空patch・不正grammarはファイル変更前に拒否する。複数fileのCUT→PUTを同一batchで解決し、registerはsession内に保持する。
4. `N*` はMarkdownのheading sectionと、TypeScript/TSX/JavaScript/JSXの構文blockをサポートする。Markdownは同じ/上位levelの次heading手前まで、TS/JSは既存root依存のTypeScript compiler APIでASTを解析し、指定行で始まる最外側の宣言/statementをdecorator/JSDoc含めて解決する。multiline openerのみ許可。その他の言語・単一行・曖昧な位置は `Block locator unsupported; use an explicit line range` を返す。通常の範囲編集は全UTF-8テキストで可能。未対応言語で括弧数えの推測をしない。
5. sessionが読んだ最新snapshotのtag、表示済み対象行、現在の完全な正規化内容が一致することを要求する。独自版はoh-my-piのstale remappingを実装せず、変更後は `Stale snapshot; read the file again` で拒否する。16bit hash一致だけで変更なしと判定しない。CUT/PUTのrangeとblockは対象全行がseenである必要があり、gapは隣接anchor行のseenが必要。REM/MVは全文seenを要求する。未読fileの編集をtag推測で許可しない。
6. `WorkspaceFiles.commit(workspaceId,changes)` にparse後の `{path,expectedRevision,beforeBytes,afterBytes,operation,moveDest?}` を渡す。host共通mutation gate内で全source/destinationのpathとrevisionをvalidate→全変更計算済み内容をstage→commitする。realpathでworkspace外symlinkを拒否し、MVの既存destinationは拒否。commit直前にraw bytesを再照合する。各fileは同dir一時file→renameで更新し、複数fileのI/O失敗は適用済み/未適用を正確に返す。multi-file全体や外部editorとの原子的transactionとは称さない。成功fileだけsnapshot/tagを更新し、新headerとdiffを返す。filesystem policyとqueueはHashline内に重複実装しない。
7. `write({path:string,content:string})` は `WorkspaceFiles.create(workspaceId,path,Buffer.from(content,'utf8'))` に委譲する。新規file専用exclusive create、既存は `File exists; use read and edit`。parent directoryはworkspace内で作成し、overwriteは必ずread/editへ誘導する。builtin bashとユーザーPTYによる変更はmutation gateの対象外だがraw revision検査で次の編集時に検出する。これはsandboxではないとUIに明記する。

### 内蔵Playwright Browser use

1. 新規 `src/server/tools/browser.ts` に `BrowserManager` とcustom tool `browser`。Playwright Chromiumをhostでlazy launchし、agent sessionごとに独立BrowserContext。親子にcookie/tabを自動共有しない。sessionで現在tabを暗黙に選ばずtabIdで明示する。popupもcontextのpage eventで登録する。
2. 契約: `{action:'open',url?:string}`、`{action:'tabs'}`、`{action:'navigate',tabId,url}`、`{action:'read',tabId}`、`{action:'click',tabId,selector}`、`{action:'fill',tabId,selector,value}`、`{action:'press',tabId,selector,key}`、`{action:'screenshot',tabId,fullPage?:boolean}`、`{action:'evaluate',tabId,expression:string}`、`{action:'close',tabId}`。evaluateはpage.evaluateによるページ内JS式で、Nodeコードやhostのsecretを渡さない。
3. navigateはhttp/httpsのみ、waitUntil=domcontentloaded、30秒timeout。locator操作は10秒timeout。URL/title/statusを返し、HTTP 404/500もstatusとして表示する。readは `page.locator('body').innerText()` とtitle/url、操作候補としてa/button/input/select/textareaのtag/text/role/name/idを返す。最大64KiB、truncatedを明示。per-tab queueで競合操作を直列化する。[Playwright APIs](https://playwright.dev/docs/api/class-page)
4. screenshotはPNG bufferをPi ImageContentとUI artifactにする。artifactはhostがUUIDを割当、agent/sessionへ紐づけ、認証付き `/api/artifacts/:id` で取得する。ブラウザー操作はツール結果として会話に記録する。閉じた/別agentのtabは明示エラー。キャンセル中のtab操作はそのtabを閉じて中断、team停止/host停止時はcontextをcloseする。Chromium未インストールなら `Run npx playwright install chromium` を設定画面とtool errorに出す。代替の偽browserへfallbackしない。

### 複数Web検索と設定

1. 新規 `src/server/tools/search.ts` と `search-providers/brave.ts` / `tavily.ts`。`web_search({query:string,provider?:'brave'|'tavily',limit?:number,timeRange?:'day'|'week'|'month'|'year'})` → `{provider,query,results:[{title,url,snippet}]}`。limit既定5、1..20。空queryは拒否。providerは明示指定または設定 `search.defaultProvider`、既定brave。key未設定・provider不正は設定へ誘導するerrorで、別providerへ黙ってfallbackしない。
2. Brave: GET `https://api.search.brave.com/res/v1/web/search`、`X-Subscription-Token`、query `q,count,result_filter=web,text_decorations=false`。timeRangeはpd/pw/pm/py。`web.results` のtitle/url/descriptionを正規化、web欠落は空結果。Braveの600文字/75語制限はadapterで事前エラー。[official contract](https://api-dashboard.search.brave.com/api-reference/web/search/get)
3. Tavily: POST `https://api.tavily.com/search`、Bearer key、JSON `{query,max_results,search_depth:'basic',topic:'general',auto_parameters:false,include_answer:false,include_raw_content:false,time_range?}`。resultsのcontentをsnippetへ。HTTP error/429はredacted errorとして通知し、自動retry/fanoutしない。両adapterはAbortSignalと30秒timeoutを使う。[official contract](https://docs.tavily.com/documentation/api-reference/endpoint/search)
4. `/api/settings` GET/PATCHで `search.defaultProvider`、`teams.maxConcurrentAgents`、`teams.maxDepth`、LLM default provider/modelを管理する。search keyは `/api/credentials/search/:provider` PUT `{key}` / DELETEに分離し、GETはconfigured booleanだけ返す。設定はagentDir/web-harness/settings.json、secretは同credentials.jsonに別保存、POSIXでは0600、Windowsではユーザーprivate dirを使う。保存はatomic rename、未指定keyは保持し空文字で削除しない。新しい検索呼び出しから設定を反映する。
5. LLMはPiの既存auth.json/models.jsonと環境変数の設定を再利用する。Web settingsに `ModelRuntime.getProviders()` / `getModels()` の選択と `setRuntimeApiKey(providerId,key)` による現在プロセスのAPI key入力を実装する。runtime keyは再起動で消えるとUIに表示し、既存Pi永続credentialsはそのまま利用可能とする。OAuth/任意provider登録の新方式を追加しない。新規sessionはdefault model、既存は記録済みmodel、変更はidle時のみ認める。credential値はGET、snapshot、errors、consoleに返さない。[runtime source](https://github.com/earendil-works/pi/blob/c5f5b3282d5e4203c085e59837ba17aeaf2829b5/packages/coding-agent/src/core/model-runtime.ts)
6. search providerの共通境界は `SearchProvider.search(request,signal): Promise<SearchResult>` に限定し、brave/tavilyの静的registryで実装を選ぶ。設定画面・tool・APIでそれぞれprovider分岐を書かない。plugin frameworkやproviderごとのHTTP endpointは追加しない。

### ユーザー操作のPTY

1. 新規 `src/server/terminal-manager.ts` に `TerminalManager` を実装する。汎用pipeのchild_processをPTYと称さず、`node-pty@1.1.0` を使う。browserは `@xterm/xterm@6.0.0`、`@xterm/addon-fit@0.11.0`、hostの再接続用screenは `@xterm/headless@6.0.0` と `@xterm/addon-serialize@0.14.0`。固定版をmanifest/lockに追加し、native addonはbundleせずexternalにする。[node-pty API](https://unpkg.com/node-pty@1.1.0/typings/node-pty.d.ts) / [xterm reconnect](https://github.com/xtermjs/xterm.js#nodejs-support)
2. terminalIdはUUID、所属はworkspaceIdだけ。sessionIdやteam/runへ結合しない。`POST /api/terminals {workspaceId,cols,rows}` で明示作成、GETでworkspaceのterminal一覧、`DELETE /api/terminals/:id` でkill。PTYはworkspace cwd、Windows既定shellは `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` と `['-NoLogo']`、POSIXは `$SHELL` または `/bin/sh`。envはprocess.envを継承しSystemRootを落とさない。spawnエラーは明示しpipe fallbackをしない。`pty.spawn`、`onData`、`onExit`、`write`、`resize`、`pause/resume`、`kill()` を使う。Windows killにsignalを渡さず、終了後listenerをdisposeする。
3. 端末は `running|exited`、exitCode/signalと最終screenを保持する。UIのsession切替・terminal panel非表示・browser切断でkillしない。明示Closeとhost shutdownでkill、再起動後にshellが復活したように表示しない。PTY入出力を会話、ディスクlog、telemetryへコピーしない。PTYはagentのtoolとして提供せず、agent bashとは独立。
4. `/api/terminals/:id/events` の認証付きWSでattachする。terminalごとに操作可能connectionは一つ、後続attachはviewer、`{type:'take_control'}` で明示移譲し全connectionへ `{type:'control',controller:boolean}` を通知する。旧connectionのinput/resizeは拒否。input `{type:'input',generation,data}` はxterm.onDataをそのままpty.write、binaryは `{type:'binary',generation,data}` をBuffer.from(data,'binary')でwrite。resize `{type:'resize',generation,cols,rows}` は正整数/cols<=500/rows<=200、host/headless/browserを揃える。output streamに `{type:'resized',generation,seq,cols,rows}` と `{type:'exit',generation,seq,exitCode,signal?}` も含め、viewerはresizeをhostへechoしない。入力/resizeを自動再送しない。
5. hostはPTY出力を同geometryのheadless xtermに全量parseし、scrollback=2000。terminal別queueでwrite callback、resize、snapshot barrierを順序化する。attachは `{type:'snapshot',terminalId,generation,seq,cols,rows,vt,status,exitCode?}` を先に送り、vtはSerializeAddon.serialize({scrollback:2000})。clientは新emulatorにwriteしてcallback後にACK、以後 `{type:'data',generation,seq,data}` を順序適用する。snapshot以後のoutputはattach queueへ溜め、snapshot ACK後に送る。raw ANSIの末尾切出しをsnapshotとして使わない。[flow control](https://xtermjs.org/docs/guides/flowcontrol/)
6. headless未parse出力はJS code unit数で追跡し256Ki超でpty.pause、64Ki未満でresume。attachment別の未ACK/未送信は1Mi code unit、ws.bufferedAmountは2MiBを上限にし、遅いclientだけdetachして新snapshotへ誘導する。ACKはxterm.write callback後、generationと送信済みseqを照合する。screen retentionは2000行であって全文記録ではない。client切断でhost screen処理を止めない。
7. 新規 `src/client/terminal/TerminalPane.tsx` はxterm.open、FitAddon、ResizeObserver、xterm CSSを利用する。visibleかつ寸法非zero時だけfit、実寸変更時だけresizeを送る。React panel disposalはbrowser emulatorだけdisposeする。Create/Close、terminal tabs、Control/View-only表示、exit codeを提供する。titleはtext、リンクはユーザー操作のhttp/httpsのみ、OSC clipboard自動書込を実装しない。Windows native install失敗時はPythonとVS2022 C++/Windows SDK/Spectre libraryを案内し、欠けたPTYを完成扱いしない。[installation](https://github.com/microsoft/node-pty#dependencies)


### 複数セッションを扱うWeb操作面

1. React UIは左にworkspace/session一覧、中央に選択sessionのチャット、右にファイル/チーム/tool inspectorの切替、下にユーザーterminal panel、上にmodelとsettings。日本語ラベルを既定とし、tool名やコードはそのまま表示する。workspace追加はローカル絶対path入力、実directoryをserverで確認。workspace選択前はcomposerを無効にする。複数root sessionを同時に実行でき、一覧にそれぞれのrunning/idle/error状態を表示する。選択変更は表示のattach変更だけで、非選択sessionの実行・queue・ツールを止めない。
2. 会話はuser/assistant/thinking/toolを区別し、stream表示、Stop、busy時のsteer/follow-up選択を実装する。Markdownはraw HTMLを無効化して描画し、外部リンクはnoopener/noreferrer。server出力をinnerHTMLへ直接入れない。
3. tool cardはcallId、名前、入力、partial/final結果、running/success/error/cancelledを表示する。Hashlineは新headerと変更diff、browserはtabs/action/screenshot、searchはtitle/URL/snippet、teamは親子tree、task/status/resultと子会話リンクを持つ。失敗やinterruptedをcompletedの色にしない。
4. session切替・page reload・host restartから履歴を戻せる。子会話を開いても親をdisposeしない。hostでactive sessionを一つに絞らない。workspace summary streamで非選択sessionの状態を受け取り、選択sessionだけ詳細streamを購読する。チームは「親子tree + 各taskの状態 + wait対象 + 最新結果」で表示し、グラフ描画ライブラリや全面的workflow editorを追加しない。子クリックで会話/ツール詳細を開き、親へ戻れる。設定error、接続切れ、モデル/検索key未設定、browser未準備はその場に表示する。

## Critical files & anchors

実装前に固定commitの実ファイルを再読する。以下は調査済み既存seamであり、新規fileの推測ではない。

- `packages/coding-agent/src/core/sdk.ts` — CreateAgentSessionOptionsとfactory。同名customToolsとservices注入。
- `packages/coding-agent/src/core/agent-session.ts` — subscribe/prompt/steer/followUp/abort/waitForIdle、agent_settled、tool registry。Webとteamのlifecycleをここへ合わせる。
- `packages/coding-agent/src/core/session-manager.ts` — create/open、parentSession、JSONLのauthoritative context。
- `packages/coding-agent/src/core/resource-loader.ts` — DefaultResourceLoader、appendSystemPrompt、reload。子のroleとresourceを分離する。
- `packages/coding-agent/src/core/extensions/types.ts` — ToolDefinition、TypeBox、executeとAgentToolResult。旧SDKの引数順を使わない。

## Verification

計画段階はremote source調査のみ。以下を実装後に実行し、未実行を成功と報告しない。

### Commands and prerequisites

repo root、Node >=22.19、npm、Chromiumのダウンロード接続。実API smokeにはPi対応LLMの有効credential、Brave/Tavilyの各keyが必要。

1. `npm install --ignore-scripts`、次に明示許可したnative packageだけ `npm rebuild node-pty --ignore-scripts=false --foreground-scripts`。node-ptyのinstall/postinstallでnative binaryとConPTY resourcesを準備する。load確認 `node -e "console.log(typeof require('node-pty').spawn)"` のあと実PTY smokeを行う。prebuildが使えなければPython 3.11/3.12、VS2022 C++ Build Tools/Windows SDK/Spectre libraryを用意して同rebuildを実行する。rootの全dependency lifecycle scriptを無条件に許可しない。
2. `npm run build`（ネットワーク利用不可で既存model dataが揃っている場合は `npm run build:offline`）
3. `npx playwright install chromium`
4. `npm run test --workspace=@hasilan/pi-web-harness`
5. `npm run web -- --no-open --port 3080 --cwd <temporary-fixture-directory>`

workspace Vitestは既存 `vitest.base.ts` のaliasを再利用する。恒久テストはconsumer-visible境界に絞る。実APIの不足はmock成功で代用せず不足credentialを報告し、それ以外の実host/browser/file smokeを完了させる。

### Behavioral proof

- Webの実画面を開く。新workspace→新session→モデル設定→入力→stream→最終回答→reloadで同じ会話、host restart後にも履歴が戻る。busyのfollow-up、Stop、切断中の継続と再attachを実行し、agent_settledまで正しい状態を確認する。
- team: rootへ「調査役と編集役を同時に作り、両者の結果を待って統合」と依頼し、別sessionIdの2子、並列進行、sendの会話への到達、wait結果、親最終回答をWebと保存履歴で確認。恒久テストはlimitのqueue/cancel、wait cycle、異なるteam参照拒否、restartのinterrupted、子Stopが兄弟を止めないことを検証する。実LLM smokeで動的spawnと統合を一度通す。
- Hashline実file: `one\ntwo\nthree\n` をreadし、返されたtagで `PUT 2.=2:` / `+TWO` → bytesは `one\nTWO\nthree\n`、新tagとUI diff。古いtagは拒否しfile不変。範囲readで未表示行の変更は拒否。2agentが同snapshotを読み同fileを書いたら一方だけ成功し他方はstale。register CUT/PUT、Markdown/TSのN*、REM/MV conflict、新file write/既存write拒否も実fixtureで確認する。自作empty/Unicode/CRLF/BOM/trailing whitespace fixtureで正規化とhash仕様を検証し、oh-my-pi由来のtest/codeをimportしない。未知言語N*は明示unsupported。
- Browser: ローカルfixture HTTPページにlink、form、button、popupを用意する。実Chromiumのopen→read→fill→click→navigate→screenshot→closeを実行し、form結果・URL・popup一覧・PNGのWeb表示を観測する。親と子のcookieが分離し、他agent tabへの操作が拒否されることを検証する。fixtureをAPI authなしの外部Web公開と混同しない。
- Search: Brave/Tavilyを各設定し同じqueryを実行、provider名・実リンクをWebで確認する。HTTP fixtureで0件、401、429、cancel、timeoutを検証し、keyなしで別providerへfallbackしないこと、settings GET/WS/logに入力keyが出ないことを確認する。Brave/Tavilyのrequestコピーだけを恒久テストにしない。
- ローカル安全境界: cookieなしAPIは401、異なるOriginの変更request/WSは拒否、workspace外symlinkのHashline編集拒否、会話に `<script>` を含むtool結果を表示して実行されないことを実host/ブラウザーで確認する。
- 複数session: A/Bの2rootで同時に実LLM処理を開始、切替/reload中も両方進み、各最終結果と履歴が混ざらないこと。旧subscription snapshotの遅延とseq gapも検証する。空sessionのrestartとmaterialized JSONL削除を区別する。
- scheduler: maxConcurrentAgents=1でrootがchildをspawn/wait、childがgrandchildをspawn/waitし全結果がtimeoutなしで戻る。wait中のchild再開がpin済みrun結果を変えないこと、self/ancestor stop拒否、stopとspawn/send競合で後発実行が漏れないこと、pending入力がrestartで自動再送されないことを検証する。
- file viewer: Unicode/CRLF、空file、PNG、binary、HTML/SVG script文字列を実Webで開き、正しく表示してscriptを実行しない。viewerだけで見たfileへのagent editは未読として拒否。PTYでfile変更後Refreshは最新を表示し、旧Hashline snapshotはstale拒否。外部junction、drive-relative、ADS、空白/#/%付きfilenameも確認する。
- PTY: 実Windows PowerShellで `Write-Output 'PTY_OK'`、Unicode入力、paste、Ctrl-C、`$Host.UI.RawUI.WindowSize` とresize、`exit 7` のexitCode表示を確認する。2terminalを開きsession切替/browser reloadでも同terminalId/processを保つ。連続出力中の切断/reconnectはscreen復元と重複なし、slow viewerは他terminalを止めない。agent StopはPTYをkillせず、明示Closeだけ対象PTYを閉じ、host終了は全所有PTYを閉じる。

## Assumptions & contingencies

- 利用形態はユーザー確認済みのローカル単一ユーザー。プロセスは起動ユーザーの権限でbash/browserを実行する。Hashlineのpath検査をsandboxと説明しない。公開サーバー用の複数ユーザー認証/実行隔離はこの配備方式に含めない。
- 複数検索はまずBraveとTavilyを実装する。userはプロバイダー名を固定していないため、この2つを既定の具体化として採用する。
- 独自Hashlineはoh-my-pi形式を保ち、stale自動回復なし、N*の対応はMarkdownとTS/JS。その他言語は明示rangeを使用できる。これをtool descriptionとUIに明記し、完全なoh-my-pi互換とは称さない。
- フォーク先GitHub URLとブランド指定がないため、ローカルforkとpackage名 `@hasilan/pi-web-harness` を使用する。URLが後で与えられた場合のみoriginの付替え/pushを追加する。
- npm依存の具体的versionは実装時にregistryで確認してexact pinし、lockへ固定する。利用可能な公開版を使い、Node非対応やBun専用のライブラリを避ける。既存rootのTypeScript compilerをHashline AST解決に再利用する。

## キャッシュ改善調査（2026-10-18）

この節は調査時点の設計比較であり、上記の初期計画とは分けて読む。以下の改善は実装済み。動的状態の永続追記、共通プロンプトの先頭への配置、ツール名・スキーマ順序の安定化、対応するOpenAI APIキー経路での宣言保持と利用制限、親子・モデル別の使用量表示を追加した。system更新は既存SDKのモデル別能力を引き続き使用する。現在の仕様は[Web README](packages/web-harness/README.md#キャッシュと使用量)を参照。モデル API は呼び出しておらず、実際のヒット率・料金・応答時間の改善は未測定。

### DeepSeek Harnessで参考になる設計

- 固定の指示と動的な実行状態を分離する。動的状態は変更時だけ履歴末尾へ永続スナップショットを追加し、圧縮で失われたときは再投入する。[設計と実装](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/runtime-context.ts)
- system promptの途中更新はモデル単位の能力で選択する。対応モデルでは変更済みの完全なsystem promptを履歴末尾へ追加し、未対応モデルや圧縮後の新しい系列では先頭へ集約する。後勝ちの完全置換を全モデルへ仮定しない。[設計](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-09-02-in-history-system-prompt-replacement.md)
- ツール定義とその順序を安定させる。動的な追加・削除も、対応するモデルだけ履歴内更新を使う。既存定義の変更はキャッシュを維持できるとは限らない。[組み立て順序](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/README.md)、[動的ツール更新](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-09-20-dynamic-tool-updates.md)

### 調査時点の差分と実装の優先順位

| 優先度 | 調査時の実装 | 採用した改善案 |
| --- | --- | --- |
| 1 | `SessionRegistry`の`context`フックはGoal/Swarm状態を各リクエストの末尾へ一時追加するが、会話履歴には保持しない。 | 状態の変更時だけ永続スナップショットを追記する。変化がなければ履歴内の同じメッセージを維持し、重複追加しない。圧縮・再起動・解除時も有効状態を正しく復元する。 |
| 2 | `buildSystemPromptSections()`は子のroleや追加指示を`addendum`に置き、その後に共通のproject contextやskillsを置く。 | 共通指示を先、担当固有の内容を後へ配置する。同じモデル・ツール集合の子同士で共有可能な先頭部分を長くする。 |
| 3 | Swarm開始・終了やGoal開始で`setActiveToolsByName()`がツール集合を切り替える。 | ツール順序・スキーマを正規化し、モデルが対応する場合だけ宣言を保った利用制限や遅延追加を使う。子の実行権限は広げない。 |
| 4 | SDKにはsystem section差分と`supportsMidConvoSystemMessages`による送信分岐が既にある。 | 第二の仕組みを新設せず既存機能を使う。各モデルの能力を確認してから有効化する。 |
| 5 | SDKは`usage.cacheRead`・`cacheWrite`を集計できるが、Web projectionにはassistantのusageを載せていない。 | モデル別・親子別に入力のキャッシュ読み取り率と料金を表示し、モード切替・圧縮の前後を比較できるようにする。 |

ローカルの実際の`convertMessages()`で、system sectionをMode AからMode Bへ変更する送信シナリオを実行した。現在固定しているカタログの`deepseek-flash`は途中system対応フラグがなく、先頭systemが書き換わるため旧入力のprefixを保持しなかった。`deepseek-v4-pro`は同フラグが有効で、途中systemを追加し旧入力のprefixを保持した。これはシリアライズの確認であり、モデル側が更新指示をどう解釈するかやキャッシュヒットの実証ではない。DeepSeek Harnessの独自アダプターが宣言する能力をPiの互換アダプターへそのまま移さない。

SDKでは`input`がキャッシュ読み取り・書き込みを除いた値なので、入力の読み取り率は`cacheRead / (input + cacheRead + cacheWrite)`で計算する。集計は率の単純平均ではなくトークン数の合計から求め、入力ゼロは率なしとする。実際の改善判定ではヒット率だけでなく、完了タスクあたりの料金・応答時間・失敗数も比較する。

キャッシュは先頭部分の一致が条件であり、UUIDを短いIDへ変えるだけでは主要な対策にならない。履歴を不変に保つこと、同一モデル内で比較すること、必要な圧縮や権限制限をヒット率のために無効化しないことを優先する。DeepSeekは自動キャッシュを提供するがbest effortで、完全一致する保存済みprefix単位が必要。[DeepSeek公式仕様](https://api-docs.deepseek.com/guides/kv_cache)

OpenAIも共有指示・履歴・ツール定義の安定化を推奨する。ただし`prompt_cache_key`の効果や明示breakpoint・保持期間はモデル世代で異なるため、全モデルへ一つの設定を強制しない。[OpenAI公式仕様](https://developers.openai.com/api/docs/guides/prompt-caching)
