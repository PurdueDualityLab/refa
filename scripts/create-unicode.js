const fs = require("fs");
const path = require("path");
const { CharSet } = require("../src/char-set");
const { runEncodeCharacters } = require("../src/char-util");
const aliases = require("../src/js/unicode/alias");


const UNICODE_SRC_DIR = path.join(__dirname, "../src/js/unicode");

createDataFile(Object.values(aliases.Binary_Property), "Binary_Property", "binary-property-data.ts");
createDataFile(Object.values(aliases.General_Category), "General_Category", "general-category-data.ts");
createDataFile(Object.values(aliases.ScriptAndScript_Extensions), "Script", "script-data.ts");
createDataFile(Object.values(aliases.ScriptAndScript_Extensions), "Script_Extensions", "script-extensions-data.ts");


/**
 * @param {Iterable<string>} properties
 * @param {string} category
 * @param {string} filename
 */
function createDataFile(properties, category, filename) {
	console.log(`Creating ${filename}`);

	const values = new Set(properties);

	let code = `"use strict";
/* eslint-disable @typescript-eslint/camelcase */
/* eslint-disable max-len */

// DO NOT EDIT!
// THIS FILE IS GENERATED BY scripts/create-unicode.js

// Category: ${category}
// Exported ranges: ${[...values].join(", ")}

import { CharRange } from "../../char-set";


`;

	for (const prop of values) {
		/** @type {number[]} */
		const codePoints = require(`unicode-13.0.0/${category}/${prop}/code-points`);
		const ranges = CharSet.empty(0x10FFFF).union(runEncodeCharacters(codePoints)).ranges;
		code += `export const ${prop}: readonly CharRange[] = ${printRanges(ranges)};\n`;
	}

	fs.writeFileSync(path.join(UNICODE_SRC_DIR, filename), code, "utf-8");
}

/**
 * @param {Iterable<import("../src/char-set").CharRange>} ranges
 * @returns {string}
 */
function printRanges(ranges) {
	let s = "[";
	let i = 0;
	for (const { min, max } of ranges) {
		if (i++ > 0) {
			s += ", ";
		}
		s += `{min:0x${min.toString(16).toUpperCase()},max:0x${max.toString(16).toUpperCase()}}`;
	}
	return s + "]";
}