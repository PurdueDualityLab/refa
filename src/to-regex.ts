import {
	Simple,
	Expression,
	Node,
	Parent,
	Concatenation,
	Alternation,
	CharacterClass,
	Quantifier,
	Element,
	Assertion,
	visitAst,
} from "./ast";
import { CharSet } from "./char-set";
import { cachedFunc, DFS, firstOf, minOf, assertNever, filterMut } from "./util";
import { ToRegexOptions, TooManyNodesError, FAIterator } from "./finite-automaton";

type RegexFANodeTransition = Simple<Concatenation | Alternation | CharacterClass | Quantifier>;
interface RegexFANode {
	out: Map<RegexFANode, RegexFANodeTransition>;
	in: Map<RegexFANode, RegexFANodeTransition>;
}
class NodeList {
	readonly initial: RegexFANode;
	readonly finals: Set<RegexFANode>;

	constructor() {
		this.initial = this.createNode();
		this.finals = new Set();
	}

	createNode(): RegexFANode {
		return {
			in: new Map(),
			out: new Map(),
		};
	}

	linkNodes(from: RegexFANode, to: RegexFANode, transition: RegexFANodeTransition): void {
		if (from.out.has(to)) {
			throw new Error("The two nodes are already linked");
		}
		from.out.set(to, transition);
		to.in.set(from, transition);
	}

	unlinkNodes(from: RegexFANode, to: RegexFANode): RegexFANodeTransition | undefined {
		const t = from.out.get(to);
		if (t !== undefined) {
			from.out.delete(to);
			to.in.delete(from);
		}
		return t;
	}

	relinkNodes(from: RegexFANode, to: RegexFANode, newTransition: RegexFANodeTransition): void {
		if (!from.out.has(to)) {
			throw new Error("The two nodes are not linked");
		}
		from.out.set(to, newTransition);
		to.in.set(from, newTransition);
	}
}

class TransitionCreator {
	private _counter: number = 0;
	constructor(public readonly max: number) {}

	private _incrementCounter(): void {
		if (++this._counter > this.max) {
			throw new TooManyNodesError(`Too many RE AST nodes. Reached maximum of ${this.max}.`);
		}
	}

	concat(elements: Simple<Concatenation>["elements"]): Simple<Concatenation> {
		this._incrementCounter();

		return {
			type: "Concatenation",
			elements,
		};
	}
	emptyConcat(): Simple<Concatenation> {
		this._incrementCounter();

		return {
			type: "Concatenation",
			elements: [],
		};
	}

	alter(alternatives: Simple<Alternation>["alternatives"]): Simple<Alternation> {
		this._incrementCounter();

		return {
			type: "Alternation",
			alternatives,
		};
	}
	emptyAlter(): Simple<Alternation> {
		this._incrementCounter();

		return {
			type: "Alternation",
			alternatives: [],
		};
	}

	expression(alternatives: Simple<Expression>["alternatives"]): Simple<Expression> {
		this._incrementCounter();

		return {
			type: "Expression",
			alternatives,
		};
	}
	emptyExpression(): Simple<Expression> {
		this._incrementCounter();

		return {
			type: "Expression",
			alternatives: [],
		};
	}

	char(characters: CharSet): Simple<CharacterClass> {
		this._incrementCounter();

		return {
			type: "CharacterClass",
			characters,
		};
	}

	quant(alternatives: Simple<Quantifier>["alternatives"], min: number, max: number): Simple<Quantifier> {
		this._incrementCounter();

		return {
			type: "Quantifier",
			alternatives,
			min,
			max,
		};
	}
	quantStar(alternatives: Simple<Quantifier>["alternatives"]): Simple<Quantifier> {
		this._incrementCounter();

		return {
			type: "Quantifier",
			alternatives,
			min: 0,
			max: Infinity,
		};
	}
	quantPlus(alternatives: Simple<Quantifier>["alternatives"]): Simple<Quantifier> {
		this._incrementCounter();

		return {
			type: "Quantifier",
			alternatives,
			min: 1,
			max: Infinity,
		};
	}

	copy(t: Simple<Concatenation>): Simple<Concatenation>;
	copy(t: RegexFANodeTransition): RegexFANodeTransition;
	copy(t: RegexFANodeTransition): RegexFANodeTransition {
		switch (t.type) {
			case "Alternation":
				return this.alter(t.alternatives.map(a => this.copy(a)));
			case "Concatenation":
				return this.concat(t.elements.map(e => this.copy(e as RegexFANodeTransition) as Simple<Element>));
			case "CharacterClass":
				return this.char(t.characters);
			case "Quantifier":
				return this.quant(
					t.alternatives.map(a => this.copy(a)),
					t.min,
					t.max
				);

			default:
				throw assertNever(t);
		}
	}
}

function createNodeList<T>(iter: FAIterator<T, Iterable<[T, CharSet]>>, tc: TransitionCreator): NodeList | null {
	const nodeList = new NodeList();

	// the state elimination method requires that the initial state isn't final, so we add a temp state
	// the transition [initial] -> [tempInitial] is an epsilon transition
	const tempInitial = nodeList.createNode();
	nodeList.linkNodes(nodeList.initial, tempInitial, tc.emptyConcat());

	const translate = cachedFunc<T, RegexFANode>(() => nodeList.createNode());
	translate.cache.set(iter.initial, tempInitial);

	DFS(iter.initial, n => {
		// set final
		if (iter.isFinal(n)) {
			nodeList.finals.add(translate(n));
		}

		// out transitions sorted by char set
		const out = [...iter.getOut(n)].sort(([, a], [, b]) => {
			const diff = Number(a.isEmpty) - Number(b.isEmpty);
			if (diff !== 0) return diff;

			for (let i = 0, l = Math.min(a.ranges.length, b.ranges.length); i < l; i++) {
				const aR = a.ranges[i];
				const bR = b.ranges[i];
				if (aR.min !== bR.min) return aR.min - bR.min;
				if (aR.max !== bR.max) return aR.max - bR.max;
			}
			return a.ranges.length - b.ranges.length;
		});

		out.forEach(([outNode, charSet]) => {
			nodeList.linkNodes(translate(n), translate(outNode), tc.char(charSet));
		});

		return out.map(x => x[0]);
	});

	if (nodeList.finals.size === 0) {
		// empty language
		return null;
	}

	// make a new final state with no outgoing edges
	const tempFinal = nodeList.createNode();
	nodeList.finals.forEach(n => {
		// add epsilon transition
		nodeList.linkNodes(n, tempFinal, tc.emptyConcat());
	});
	nodeList.finals.clear();
	nodeList.finals.add(tempFinal);

	// we now have an FA with one initial (source) and one final (drain) state

	// remove all states which cannot reach the final state
	const alive = new Set<RegexFANode>();
	DFS(tempFinal, n => {
		alive.add(n);
		return n.in.keys();
	});
	const dead = new Set<RegexFANode>();
	DFS(nodeList.initial, n => {
		if (!alive.has(n)) {
			dead.add(n);
		}
		return n.out.keys();
	});
	dead.forEach(n => {
		n.out.forEach((_, outNode) => {
			nodeList.unlinkNodes(n, outNode);
		});
		n.in.forEach((_, inNode) => {
			nodeList.unlinkNodes(inNode, n);
		});
	});

	return nodeList;
}
function eliminateStates(nodeList: NodeList, tc: TransitionCreator): void {
	const initial = nodeList.initial;
	const final = firstOf(nodeList.finals)!;

	const remainingStates = new Set<RegexFANode>();
	DFS(initial, n => {
		if (n !== initial && n !== final) {
			remainingStates.add(n);
		}
		return n.out.keys();
	});

	function linkWithUnion(from: RegexFANode, to: RegexFANode, trans: RegexFANodeTransition): void {
		const currentTrans = nodeList.unlinkNodes(from, to);
		if (currentTrans) {
			trans = union(currentTrans, trans);
		}
		nodeList.linkNodes(from, to, trans);
	}

	function concat(a: RegexFANodeTransition, b: RegexFANodeTransition): RegexFANodeTransition {
		if (a.type === "Concatenation") {
			if (a.elements.length === 0) return b;
			if (b.type === "Concatenation") {
				a.elements.push(...b.elements);
			} else if (b.type === "Alternation") {
				factorOutCommonPreAndSuffix(b);
				a.elements.push(b);
			} else {
				a.elements.push(b);
			}
			inlineConcat(a);
			return a;
		}
		if (b.type === "Concatenation") {
			if (b.elements.length === 0) return a;
			if (a.type === "Alternation") {
				factorOutCommonPreAndSuffix(a);
				b.elements.unshift(a);
			} else {
				b.elements.unshift(a);
			}
			inlineConcat(b);
			return b;
		}

		if (a.type === "Alternation") {
			factorOutCommonPreAndSuffix(a);
		}
		if (b.type === "Alternation") {
			factorOutCommonPreAndSuffix(b);
		}
		const newConcat = tc.concat([a, b]);
		inlineConcat(newConcat);
		return newConcat;
	}
	function asConcatenation(a: Simple<Element | Concatenation>): Simple<Concatenation> {
		if (a.type === "Concatenation") {
			return a;
		} else {
			return tc.concat([a]);
		}
	}
	function union(a: RegexFANodeTransition, b: RegexFANodeTransition): RegexFANodeTransition {
		if (a.type === "CharacterClass" && b.type === "CharacterClass") {
			a.characters = a.characters.union(b.characters);
			return a;
		}

		if (a.type === "Alternation") {
			if (a.alternatives.length === 0) return b;

			if (b.type === "Alternation") {
				if (b.alternatives.length === 0) return a;

				for (const alt of b.alternatives) {
					if (alt.elements.length === 1) {
						const e = alt.elements[0];
						if (e.type === "CharacterClass") {
							unionAlternationAndCharClass(a, e);
							continue;
						}
					}
					a.alternatives.push(alt);
				}

				return a;
			}

			if (b.type === "CharacterClass") {
				unionAlternationAndCharClass(a, b);
				return a;
			}

			a.alternatives.push(asConcatenation(b));
			return a;
		}
		if (b.type === "Alternation") {
			if (b.alternatives.length === 0) return a;

			if (a.type === "CharacterClass") {
				unionAlternationAndCharClass(b, a);
				return b;
			}

			b.alternatives.push(asConcatenation(a));
			return b;
		}

		return tc.alter([asConcatenation(a), asConcatenation(b)]);

		function unionAlternationAndCharClass(alternation: Simple<Alternation>, char: Simple<CharacterClass>): void {
			for (const alt of alternation.alternatives) {
				if (alt.elements.length === 1) {
					const first = alt.elements[0];
					if (first.type === "CharacterClass") {
						first.characters = first.characters.union(char.characters);
						return;
					}
				}
			}
			alternation.alternatives.push(asConcatenation(char));
		}
	}
	function star(a: RegexFANodeTransition): RegexFANodeTransition {
		switch (a.type) {
			case "Quantifier":
				if (a.max === 0) return tc.emptyConcat();
				if (a.min === 0 || a.min === 1) {
					a.min = 0;
					a.max = Infinity;
					return a;
				}
				return tc.quantStar([asConcatenation(a)]);

			case "Alternation":
				return tc.quantStar(a.alternatives);

			case "Concatenation":
				if (a.elements.length === 0) return a;
				return tc.quantStar([a]);

			default:
				return tc.quantStar([asConcatenation(a)]);
		}
	}
	function plus(a: RegexFANodeTransition): RegexFANodeTransition {
		switch (a.type) {
			case "Quantifier":
				if (a.max === 0) return tc.emptyConcat();
				if (a.min === 0) {
					a.min = 0;
					a.max = Infinity;
					return a;
				}
				if (a.min === 1) {
					a.max = Infinity;
					return a;
				}
				return tc.quantPlus([asConcatenation(a)]);

			case "Alternation":
				return tc.quantPlus(a.alternatives);

			case "Concatenation":
				if (a.elements.length === 0) return a;
				return tc.quantPlus([a]);

			default:
				return tc.quantPlus([asConcatenation(a)]);
		}
	}

	function removeTrivialReflexiveTransition(state: RegexFANode): void {
		if (state.out.has(state)) {
			if (state.in.size === 2 && state.out.size === 2) {
				// (A) -[a]-> (B) -[b]-> (C)  ==  (A) -[a]-> (B) -[c*b]-> (C)  ==  (A) -[ac*]-> (B) -[b]-> (C)
				//             Δ  \
				//              \[c]

				// Since we choose the between two equivalent outcomes here, we will try to make a good choice.

				const refTrans = nodeList.unlinkNodes(state, state)!;
				const [outState, outTrans] = firstOf(state.out)!;
				const [inState, inTrans] = firstOf(state.in)!;

				if (structurallyEqual(inTrans, refTrans)) {
					// a == c  =>  (A) -[a+]-> (B) -[b]-> (C)
					nodeList.relinkNodes(inState, state, plus(refTrans));
				} else {
					if (structurallyEqual(refTrans, outTrans)) {
						// c == b  =>  (A) -[a]-> (B) -[b+]-> (C)
						nodeList.relinkNodes(state, outState, plus(refTrans));
					} else {
						// (A) -[a]-> (B) -[c*b]-> (C)
						nodeList.relinkNodes(state, outState, concat(star(refTrans), outTrans));
					}
				}
			} else if (state.out.size === 2) {
				// (A1) -[a1]-v                     (A1) -[a1]-v
				// (A2) -[a2]-> (B) -[b]-> (C)  ==  (A2) -[a2]-> (B) -[c*b]-> (C)
				// (An) -[an]-^  Δ  \               (An) -[an]-^
				//                \[c]

				const refTrans = nodeList.unlinkNodes(state, state)!;
				const [outState, outTrans] = firstOf(state.out)!;
				if (structurallyEqual(refTrans, outTrans)) {
					nodeList.relinkNodes(state, outState, plus(refTrans));
				} else {
					nodeList.relinkNodes(state, outState, concat(star(refTrans), outTrans));
				}
			} else if (state.in.size === 2) {
				//                /[b1]-> (C1)                       /[b1]-> (C1)
				// (A) -[a]-> (B) -[b2]-> (C2)  ==  (A) -[ac*]-> (B) -[b2]-> (C2)
				//          /  Δ  \[bn]-> (Cn)                       \[bn]-> (Cn)
				//         [c]/

				const refTrans = nodeList.unlinkNodes(state, state)!;
				const [inState, inTrans] = firstOf(state.in)!;
				if (structurallyEqual(inTrans, refTrans)) {
					nodeList.relinkNodes(inState, state, plus(refTrans));
				} else {
					nodeList.relinkNodes(inState, state, concat(inTrans, star(refTrans)));
				}
			}
		}
	}
	function removeTrivialConcat(state: RegexFANode): null | RegexFANode[] {
		if (state.in.size === 1 && state.out.size === 1) {
			// (A) -[a]-> (B) -[b]-> (C)  ==  (A) -[ab]-> (C)
			const [inState, inTrans] = firstOf(state.in)!;
			const [outState, outTrans] = firstOf(state.out)!;
			nodeList.unlinkNodes(inState, state);
			nodeList.unlinkNodes(state, outState);

			linkWithUnion(inState, outState, concat(inTrans, outTrans));

			remainingStates.delete(state);
			return [inState, outState];
		}
		return null;
	}

	function trivialOperations(toProcess: ReadonlySet<RegexFANode>): void {
		while (toProcess.size > 0) {
			const newToProcess = new Set<RegexFANode>();
			toProcess.forEach(state => {
				if (!remainingStates.has(state)) return;

				removeTrivialReflexiveTransition(state);

				const affected = removeTrivialConcat(state);
				if (affected) {
					affected.forEach(s => newToProcess.add(s));
				}
			});
			toProcess = newToProcess;
		}
	}

	function removeState(state: RegexFANode): Set<RegexFANode> {
		const affected = new Set<RegexFANode>([...state.in.keys(), ...state.out.keys()]);
		affected.delete(state);

		const refTrans = nodeList.unlinkNodes(state, state);
		if (refTrans) {
			const refStar = star(refTrans);
			state.in.forEach((inTrans, inState) => {
				state.out.forEach((outTrans, outState) => {
					linkWithUnion(
						inState,
						outState,
						concat(tc.copy(inTrans), concat(tc.copy(refStar), tc.copy(outTrans)))
					);
				});
			});
		} else {
			state.in.forEach((inTrans, inState) => {
				state.out.forEach((outTrans, outState) => {
					linkWithUnion(inState, outState, concat(tc.copy(inTrans), tc.copy(outTrans)));
				});
			});
		}

		state.in.forEach((_, inState) => {
			nodeList.unlinkNodes(inState, state);
		});
		state.out.forEach((_, outState) => {
			nodeList.unlinkNodes(state, outState);
		});

		remainingStates.delete(state);
		return affected;
	}

	// start by applying all trivial operations
	trivialOperations(remainingStates);

	while (remainingStates.size > 0) {
		// 1) Pick a state
		// 2) Eliminate it
		// 3) Do trivial operations

		const pickedState = minOf(remainingStates, state => {
			/**
			 * This cost function tries to minimize the length of the resulting regular expression.
			 *
			 * The cost of every starting transition of the state will be 1. The total cost to remove a state will
			 * be the number of transitions created by the removal of the state times the average cost of the operations
			 * used to get the value of a transition.
			 *
			 * The cost function for different operation will behave like this:
			 *  1. `cost(star(t)) == cost(t)`
			 *  2. `cost(concat(t1, t2)) == cost(t1) * cost(t2)`
			 *  3. `cost(union(t1, t2)) == cost(t1) + cost(t2)`
			 */

			// this will ignore the cost of a union with existing transition to estimate the cost faster
			if (state.out.has(state)) {
				// n * 3, because `cost(concat(t_in, concat(star(t_ref), t_out))) == 3`
				return (state.in.size - 1) * (state.out.size - 1) * 3;
			} else {
				// n * 2, because `cost(concat(t_in, t_out)) == 2`
				return state.in.size * state.out.size * 2;
			}
		});
		const affected = removeState(pickedState!);
		trivialOperations(affected);
	}
}

function stateElimination<T>(iter: FAIterator<T, Iterable<[T, CharSet]>>, maxAstNodes: number): Simple<Expression> {
	const tc = new TransitionCreator(maxAstNodes);

	const nodeList = createNodeList(iter, tc);
	if (nodeList == null) {
		return tc.emptyExpression();
	}

	eliminateStates(nodeList, tc);

	const [finalState] = [...nodeList.finals];
	if (finalState.in.size !== 1 || !finalState.in.has(nodeList.initial)) {
		throw new Error("State elimination failed.");
	}

	const transition = finalState.in.get(nodeList.initial)!;

	switch (transition.type) {
		case "Alternation":
			return tc.expression(transition.alternatives);
		case "Concatenation":
			return tc.expression([transition]);
		default:
			return tc.expression([tc.concat([transition])]);
	}
}

function structurallyEqual(a: Simple<Element | Concatenation>, b: Simple<Element | Concatenation>): boolean {
	if (a.type !== b.type) return false;
	switch (a.type) {
		case "Alternation": {
			const other = b as Simple<Alternation>;
			return structurallyEqualAlternatives(a.alternatives, other.alternatives);
		}
		case "Assertion": {
			const other = b as Simple<Assertion>;
			if (a.kind !== other.kind || a.negate !== other.negate) return false;
			return structurallyEqualAlternatives(a.alternatives, other.alternatives);
		}
		case "CharacterClass": {
			const other = b as Simple<CharacterClass>;
			return a.characters.equals(other.characters);
		}
		case "Concatenation": {
			const other = b as Simple<Concatenation>;
			return structurallyEqualConcatenation(a, other);
		}
		case "Quantifier": {
			const other = b as Simple<Quantifier>;
			if (a.min !== other.min || a.max !== other.max) return false;
			return structurallyEqualAlternatives(a.alternatives, other.alternatives);
		}
		default:
			throw assertNever(a);
	}
}
function structurallyEqualAlternatives(
	a: readonly Simple<Concatenation>[],
	b: readonly Simple<Concatenation>[]
): boolean {
	const l = a.length;
	if (l !== b.length) return false;
	for (let i = 0; i < l; i++) {
		if (!structurallyEqualConcatenation(a[i], b[i])) return false;
	}
	return true;
}
function structurallyEqualConcatenation(a: Simple<Concatenation>, b: Simple<Concatenation>): boolean {
	const l = a.elements.length;
	if (l !== b.elements.length) return false;
	for (let i = 0; i < l; i++) {
		if (!structurallyEqual(a.elements[i], b.elements[i])) return false;
	}
	return true;
}

/**
 * Multiplies `a` and `b`. This is guaranteed to return `0` if either or both values are `0`.
 *
 * @param a
 * @param b
 */
function safeMultiply(a: number, b: number): number {
	if (a === 0 || b === 0) {
		return 0;
	} else {
		return a * b;
	}
}

type OfType<N, T> = N extends { type: T } ? N : never;
type NodeOfType<T extends Node["type"]> = OfType<Node, T>;

function getSingleElement<T extends Element["type"]>(
	parent: Simple<Parent>,
	type: T
): undefined | Simple<NodeOfType<T>> {
	if (parent.alternatives.length === 1) {
		const alt = parent.alternatives[0];
		if (alt.elements.length === 1) {
			const e = alt.elements[0];
			if (e.type === type) {
				return e as Simple<NodeOfType<T>>;
			}
		}
	}
	return undefined;
}

function canMatchEmptyString(value: Simple<Node>): boolean {
	switch (value.type) {
		case "Assertion":
		case "CharacterClass":
			return false;

		case "Alternation":
		case "Expression":
			return value.alternatives.some(canMatchEmptyString);

		case "Concatenation":
			return value.elements.every(canMatchEmptyString);

		case "Quantifier":
			return value.min === 0 || value.alternatives.some(canMatchEmptyString);

		default:
			throw assertNever(value);
	}
}

function equalToQuantifiedElement(
	quant: Simple<Quantifier>,
	element: Simple<Element> | Simple<Concatenation>
): boolean {
	if (element.type === "Alternation") {
		return structurallyEqualAlternatives(quant.alternatives, element.alternatives);
	} else if (element.type === "Concatenation") {
		if (element.elements.length === 1) {
			return equalToQuantifiedElement(quant, element.elements[0]);
		} else {
			return quant.alternatives.length === 1 && structurallyEqualConcatenation(quant.alternatives[0], element);
		}
	} else {
		if (quant.alternatives.length === 1) {
			const alt = quant.alternatives[0];
			if (alt.elements.length === 1) {
				return structurallyEqual(alt.elements[0], element);
			} else {
				return false;
			}
		} else {
			return false;
		}
	}
}

function inlineAlternatives(parent: Simple<Parent>): boolean {
	let inlined = false;

	for (let i = 0; i < parent.alternatives.length; i++) {
		const concat = parent.alternatives[i];
		if (concat.elements.length === 1) {
			const e = concat.elements[0];
			if (e.type === "Alternation") {
				parent.alternatives.splice(i, 1, ...e.alternatives);
				i--;
				inlined = true;
			}
		}
	}

	return inlined;
}
function optimizeEmptyString(parent: Simple<Parent>): boolean {
	let optimized = false;

	if (parent.alternatives.length >= 2 && parent.alternatives.some(c => c.elements.length === 0)) {
		parent.alternatives = parent.alternatives.filter(c => c.elements.length > 0);
		optimized = true;

		if (parent.alternatives.length === 0) {
			// can't do that
			parent.alternatives.push({ type: "Concatenation", elements: [] });
		} else if (parent.alternatives.some(canMatchEmptyString)) {
			// since the empty string can be matched by at least one of the other alternatives,
			// we don't have to do anything
		} else {
			// try to change a quantifier. e.g. (?:|a+|b+) -> (?:a*|b+)
			let changed = false;
			for (const alt of parent.alternatives) {
				if (alt.elements.length === 1) {
					const e = alt.elements[0];
					if (e.type === "Quantifier" && e.min === 1) {
						// found a suitable quantifier
						e.min = 0;
						changed = true;
					}
				}

				if (changed) {
					break;
				}
			}

			if (!changed) {
				// make a new quantifier
				parent.alternatives = [
					{
						type: "Concatenation",
						elements: [
							{
								type: "Quantifier",
								min: 0,
								max: 1,
								alternatives: parent.alternatives,
							},
						],
					},
				];
			}
		}
	}

	return optimized;
}
function factorOutCommonPreAndSuffix(parent: Simple<Parent>): boolean {
	let changed = false;

	if (parent.alternatives.length >= 2) {
		let prefixLength = 0;
		let suffixLength = 0;
		const shortest = parent.alternatives.map(c => c.elements).sort((a, b) => a.length - b.length)[0];

		// find prefix length
		for (let i = 0; i < shortest.length; i++) {
			const e = shortest[i];
			if (parent.alternatives.every(c => structurallyEqual(e, c.elements[i]))) {
				prefixLength++;
			} else {
				break;
			}
		}
		// find suffix length
		for (let i = 0; i < shortest.length - prefixLength; i++) {
			const e = shortest[shortest.length - 1 - i];
			if (parent.alternatives.every(c => structurallyEqual(e, c.elements[c.elements.length - 1 - i]))) {
				suffixLength++;
			} else {
				break;
			}
		}

		if (prefixLength > 0 || suffixLength > 0) {
			changed = true;

			const prefix = shortest.slice(0, prefixLength);
			const suffix = shortest.slice(shortest.length - suffixLength, shortest.length);

			// remove prefix and suffix
			const alternatives = parent.alternatives;
			for (const alt of alternatives) {
				alt.elements.splice(0, prefixLength);
				alt.elements.splice(alt.elements.length - suffixLength, suffixLength);
			}

			parent.alternatives = [
				{
					type: "Concatenation",
					elements: [
						...prefix,
						{
							type: "Alternation",
							alternatives,
						},
						...suffix,
					],
				},
			];
		}
	}

	return changed;
}
function inlineConcat(concat: Simple<Concatenation>): boolean {
	let inlined = false;

	for (let i = 0; i < concat.elements.length; i++) {
		let e = concat.elements[i];

		// e.g. ab{1} -> ab , a(?:a*b*)? -> a(?:a*b*)
		if (e.type === "Quantifier" && e.max === 1) {
			const canInline = e.min === 1 || (e.min === 0 && e.alternatives.some(canMatchEmptyString));
			if (canInline) {
				concat.elements[i] = e = {
					type: "Alternation",
					alternatives: e.alternatives,
				};
				inlined = true;
			}
		}

		// e.g. a(?:bc)d -> abcd
		if (e.type === "Alternation" && e.alternatives.length === 1) {
			concat.elements.splice(i, 1, ...e.alternatives[0].elements);
			i--;
			inlined = true;
		}
	}

	return inlined;
}
function letQuantifiersConsumeNeighbors(elements: Simple<Element>[]): boolean {
	let optimized = false;

	function consumeNonQuantifierLeftToRight(): void {
		// make e.g. a*a -> a+
		filterMut(elements, (after, quant) => {
			if (quant && quant.type === "Quantifier" && equalToQuantifiedElement(quant, after)) {
				// e.g. a*a
				quant.min++;
				quant.max++;
				optimized = true;
				return false;
			} else {
				return true;
			}
		});
	}

	consumeNonQuantifierLeftToRight();
	elements.reverse();
	consumeNonQuantifierLeftToRight();
	elements.reverse();

	// make e.g. a*a+ -> a+
	filterMut(elements, (after, quant) => {
		if (quant && quant.type === "Quantifier" && after.type === "Quantifier") {
			if (structurallyEqualAlternatives(quant.alternatives, after.alternatives)) {
				// e.g. a+a* -> a+ , a{2,6}a{1,3} -> a{3,9}
				quant.min += after.min;
				quant.max += after.max;
				optimized = true;
				return false;
			}
		}
		return true;
	});

	return optimized;
}

function optimize(expr: Simple<Expression>): boolean {
	let optimized = false;

	function onNodeWithAlternatives(node: Simple<Alternation | Assertion | Expression | Quantifier>): void {
		optimized = inlineAlternatives(node) || optimized;
		optimized = optimizeEmptyString(node) || optimized;
		optimized = factorOutCommonPreAndSuffix(node) || optimized;
	}

	visitAst(expr, {
		onAlternationLeave: onNodeWithAlternatives,
		onAssertionLeave: onNodeWithAlternatives,
		onExpressionLeave: onNodeWithAlternatives,

		onConcatenationLeave(node) {
			optimized = inlineConcat(node) || optimized;
			optimized = letQuantifiersConsumeNeighbors(node.elements) || optimized;
		},

		onQuantifierLeave(node) {
			onNodeWithAlternatives(node);

			// e.g. (?:a+)? -> a*
			if (node.min === 0 || node.min === 1) {
				const e = getSingleElement(node, "Quantifier");
				if (e && (e.min === 0 || e.min === 1)) {
					node.min *= e.min;
					node.max = safeMultiply(node.max, e.max);
					node.alternatives = e.alternatives;
					optimized = true;
				}
			}
		},
	});

	return optimized;
}

export function faToRegex<T>(
	iter: FAIterator<T, Iterable<[T, CharSet]>>,
	options?: Readonly<ToRegexOptions>
): Simple<Expression> {
	const maxAstNodes = options?.maximumNodes ?? 10000;
	let optimizationPasses = options?.maximumOptimizationPasses ?? Infinity;

	const expression = stateElimination(iter, maxAstNodes);

	// optimize
	while (optimizationPasses > 0 && optimize(expression)) {
		optimizationPasses--;
	}

	return expression;
}
