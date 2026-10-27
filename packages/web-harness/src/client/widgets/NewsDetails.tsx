import type { NewsSnapshot } from "../../shared/widgets.ts";
import { MotionItems } from "../Motion.tsx";
import "./NewsDetails.css";

export function NewsDetails({ snapshot, error }: { snapshot?: NewsSnapshot; error?: string }) {
	const articles = snapshot?.articles.map((article, index) => ({ ...article, position: index + 1 })) ?? [];
	return <div className="widget-news">
		{error && <p role="alert" className="error">{error}{snapshot && " 以下は前回の取得分です。"}</p>}
		{!snapshot && !error && <p role="status">ニュースを取得しています…</p>}
		{snapshot?.articles.length === 0 && <p className="widget-empty">公開中のニュースはありません。</p>}
		{snapshot && articles.length > 0 && <div className="widget-news-masthead"><time dateTime={new Date(snapshot.fetchedAt).toISOString()}>{new Date(snapshot.fetchedAt).toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" })}</time></div>}
		<ol className="widget-news-list" aria-label="主要ニュース">
			<MotionItems items={articles} itemKey={(article) => article.url}>{(article) => <li key={article.url} className={article.position === 1 ? "is-lead" : undefined}>
				<a href={article.url} target="_blank" rel="noreferrer">
					<strong>{article.title}</strong>
					<time dateTime={new Date(article.publishedAt).toISOString()}>{new Date(article.publishedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
				</a>
			</li>}</MotionItems>
		</ol>
		<footer className="widget-news-footer"><a href="https://news.yahoo.co.jp/" target="_blank" rel="noreferrer">Yahoo!ニュース</a><span>5分ごとに更新</span>{snapshot && <time dateTime={new Date(snapshot.fetchedAt).toISOString()}>{new Date(snapshot.fetchedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} 取得</time>}</footer>
	</div>;
}
