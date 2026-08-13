/**
 * Element construction for the views.
 *
 * The panels used to be built as HTML strings and handed to `innerHTML`, which
 * meant every player name, SAN and opening title had to be escaped on the way
 * in and re-parsed on the way out. Values set here reach a text node or an
 * attribute directly, so there is no markup for them to escape from — and no
 * `innerHTML` for the add-on reviewer's linter to object to.
 */

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * @param {string} tag
 * @param {object} [props] `text` sets textContent, `dataset` sets data-*,
 *   `style` sets CSS properties (custom properties included), and everything
 *   else becomes an attribute. Null, undefined and false attributes are
 *   dropped, so a conditional attribute needs no branch around it.
 * @param {Array|Node|string} [children] nodes and strings; nested arrays are
 *   flattened and empty values skipped.
 */
export function el(tag, props = {}, children = []) {
	return fill(document.createElement(tag), props, children);
}

/** As `el`, for the board overlay: SVG elements need their namespace. */
export function svgEl(tag, props = {}, children = []) {
	return fill(document.createElementNS(SVG_NAMESPACE, tag), props, children);
}

/** Groups siblings that have no wrapper of their own. */
export function frag(children = []) {
	const fragment = document.createDocumentFragment();
	append(fragment, children);
	return fragment;
}

/** Replaces everything inside `target`. The counterpart of `innerHTML = …`. */
export function replaceChildren(target, children = []) {
	if (!target) {
		return target;
	}

	target.textContent = "";
	append(target, children);
	return target;
}

function fill(node, props, children) {
	for (const [name, value] of Object.entries(props || {})) {
		if (name === "text") {
			node.textContent = String(value ?? "");
		} else if (name === "dataset") {
			Object.assign(node.dataset, value);
		} else if (name === "style") {
			for (const [property, setting] of Object.entries(value || {})) {
				node.style.setProperty(property, String(setting));
			}
		} else if (value !== null && value !== undefined && value !== false) {
			node.setAttribute(name, String(value));
		}
	}

	append(node, children);
	return node;
}

function append(parent, children) {
	for (const child of Array.isArray(children) ? children : [children]) {
		if (child === null || child === undefined || child === false || child === "") {
			continue;
		}
		if (Array.isArray(child)) {
			append(parent, child);
		} else {
			parent.append(child);
		}
	}
}
