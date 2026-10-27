import { useId } from "react";

/** Local sky artwork changes with the forecast; no external image requests are needed. */
export function WeatherScene({ code }: { code: number }) {
	const id = useId();
	const snow = [71, 73, 75, 77, 85, 86].includes(code);
	const storm = [95, 96, 97, 99].includes(code);
	const rain = storm || [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code);
	const fog = code === 45 || code === 48;
	const cloudy = code >= 2;
	const theme = storm ? "storm" : snow ? "snow" : rain ? "rain" : fog ? "fog" : cloudy ? "cloudy" : "clear";
	return <svg className="widget-weather-scene" data-weather={theme} viewBox="0 0 480 320" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
		<defs>
			<linearGradient id={`${id}-sky`} x2="0" y2="1"><stop stopColor="var(--weather-sky-top)" /><stop offset="1" stopColor="var(--weather-sky-bottom)" /></linearGradient>
			<radialGradient id={`${id}-sun`}><stop stopColor="#fff2bc" stopOpacity=".75" /><stop offset="1" stopColor="#fff2bc" stopOpacity="0" /></radialGradient>
			<filter id={`${id}-cloud`} x="-40%" y="-80%" width="180%" height="260%"><feGaussianBlur stdDeviation="9" /></filter>
		</defs>
		<path fill={`url(#${id}-sky)`} d="M0 0h480v320H0z" />
		{!rain && !snow && !fog && <g className="weather-sun"><circle cx="363" cy="78" r="110" fill={`url(#${id}-sun)`} /><circle cx="363" cy="78" r="35" fill="#fff0b9" opacity={cloudy ? ".45" : ".95"} /></g>}
		<g fill="var(--weather-cloud)" opacity={cloudy ? ".75" : ".3"}>
			<g className="weather-cloud-far"><g filter={`url(#${id}-cloud)`}><ellipse cx="99" cy="76" rx="160" ry="34" /><ellipse cx="180" cy="58" rx="81" ry="35" /></g></g>
			<g className="weather-cloud-near"><g filter={`url(#${id}-cloud)`}><ellipse cx="358" cy="128" rx="190" ry="42" /><ellipse cx="444" cy="87" rx="100" ry="43" /></g></g>
		</g>
		<path d="M0 240c65-45 111-25 165-53s101 2 150-20 112-8 165-27v180H0z" fill="#7c9baa" opacity=".22" />
		<path d="M0 268c96-55 154-8 225-39s161 10 255-23v114H0z" fill="#203b52" opacity=".38" />
		{rain && <g stroke="#c4ddeb" strokeWidth="1.3" strokeLinecap="round" opacity=".6">{Array.from({ length: 26 }, (_, index) => <path key={index} className="weather-rain-drop" style={{ animationDelay: `${-index * .17}s`, animationDuration: `${.9 + index % 4 * .15}s` }} d={`M${22 + index * 19} ${index % 4 * 28}l-15 48`} />)}</g>}
		{snow && <g fill="#fff" opacity=".75">{Array.from({ length: 23 }, (_, index) => <circle key={index} className="weather-snowflake" style={{ animationDelay: `${-index * .67}s`, animationDuration: `${5 + index % 4}s` }} cx={15 + index * 21} cy={index * 47 % 90} r={index % 3 + 1} />)}</g>}
		{fog && <g className="weather-fog" stroke="#d3dfe3" strokeWidth="17" opacity=".28"><g filter={`url(#${id}-cloud)`}><path d="M-80 134h640M-80 183h640M-80 226h640" /></g></g>}
		{storm && <path className="weather-lightning" d="m370 84-29 52h23l-22 44 55-66h-25l24-30z" fill="#f9e2af" opacity=".8" />}
	</svg>;
}
