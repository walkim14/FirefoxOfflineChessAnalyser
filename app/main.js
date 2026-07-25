import { bootstrapAnalyzerApp } from "./core/analyzer-app.mjs";

bootstrapAnalyzerApp().catch((error) => {
	console.error("Failed to bootstrap analyzer app", error);
});
