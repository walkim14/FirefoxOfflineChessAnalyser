export function squareDisplayIndex(square, orientation) {
	const file = square.charCodeAt(0) - "a".charCodeAt(0);
	const rank = Number(square[1]);

	const xIndex = orientation === "white" ? file : 7 - file;
	const yIndex = orientation === "white" ? 8 - rank : rank - 1;

	return {
		x: xIndex,
		y: yIndex,
	};
}

export function squareCenterOnOverlay(square, orientation) {
	const index = squareDisplayIndex(square, orientation);
	return {
		x: index.x * 100 + 50,
		y: index.y * 100 + 50,
	};
}

export function squareName(fileIndex, rankNumber) {
	return `${String.fromCharCode("a".charCodeAt(0) + fileIndex)}${rankNumber}`;
}

export function boardCoordinates(orientation) {
	const files = orientation === "white" ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
	const ranks = orientation === "white" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];

	const coords = [];
	for (const rank of ranks) {
		for (const file of files) {
			coords.push(squareName(file, rank));
		}
	}
	return coords;
}
