export function initCollapsiblePanels(root = document) {
	const cards = root.querySelectorAll("[data-collapsible-card]");
	cards.forEach((card) => {
		const toggle = card.querySelector("[data-collapsible-toggle]");
		const content = card.querySelector("[data-collapsible-content]");
		if (!toggle || !content) {
			return;
		}

		const isExpanded = toggle.getAttribute("aria-expanded") !== "false";
		card.classList.toggle("collapsed", !isExpanded);

		toggle.addEventListener("click", () => {
			const currentlyExpanded = toggle.getAttribute("aria-expanded") !== "false";
			const nextExpanded = !currentlyExpanded;
			toggle.setAttribute("aria-expanded", String(nextExpanded));
			card.classList.toggle("collapsed", !nextExpanded);
		});
	});
}
