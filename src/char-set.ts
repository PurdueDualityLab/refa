/**
 * An immutable interval of characters with inclusive ends.
 *
 * Each interval contains all values `x` for `min <= x <= max`. Both ends have to be safe integers and `min <= max`.
 */
export interface CharRange {
	readonly min: number;
	readonly max: number;
}

// caches for empty/full char sets of different sizes.
const emptyCache = new Map<number, CharSet>();
const allCache = new Map<number, CharSet>();

/**
 * An immutable set of characters represented as a sorted set of disjoint non-adjacent intervals.
 *
 * All characters in the set have to be between 0 (inclusive) and the maximum of the set (inclusive).
 */
export class CharSet {
	/**
	 * The greatest code point which can be element of the set.
	 */
	readonly maximum: number;

	/**
	 * An array of ranges representing this character set.
	 *
	 * The array must be guaranteed to have the following properties at all times:
	 *
	 * 1. Any two ranges are disjoint.
	 * 2. Any two ranges are non-adjacent.
	 * 3. 0 <= `min` <= `max` <= `this.maximum` for all ranges.
	 * 4. All ranges are sorted by ascending `min`.
	 */
	readonly ranges: readonly CharRange[];

	/**
	 * Returns `true` if this set doesn't contain any characters.
	 */
	get isEmpty(): boolean {
		return this.ranges.length === 0;
	}
	/**
	 * Returns `true` if all characters in the range from 0 to `this.maximum`, including 0 and `this.maximum`, are in
	 * the set.
	 */
	get isAll(): boolean {
		return this.ranges.length === 1 && this.ranges[0].min === 0 && this.ranges[0].max === this.maximum;
	}

	/**
	 * Returns the number of unique characters in the set.
	 *
	 * The returned number will be at least `0` and at most `this.maximum + 1`.
	 */
	get size(): number {
		let size = 0;
		for (let i = 0, l = this.ranges.length; i < l; i++) {
			const { min, max } = this.ranges[i];
			size += max - min + 1;
		}
		return size;
	}

	private constructor(maximum: number, ranges: readonly CharRange[]) {
		this.maximum = maximum;
		this.ranges = ranges;
	}

	/**
	 * Returns a string representation of the character set.
	 */
	toString(): string {
		let s = "";
		for (const { min, max } of this.ranges) {
			if (s !== "") s += ", ";
			if (min == max) {
				s += min.toString(16);
			} else {
				s += min.toString(16) + ".." + max.toString(16);
			}
		}
		return `CharSet (${this.maximum}) [${s}]`;
	}

	/**
	 * Returns an empty character set with the given maximum.
	 *
	 * @param maximum The greatest code point which can be element of the set.
	 */
	static empty(maximum: number): CharSet {
		let emptySet = emptyCache.get(maximum);
		if (emptySet === undefined) {
			emptySet = new CharSet(maximum, []);
			emptyCache.set(maximum, emptySet);
		}
		return emptySet;
	}
	/**
	 * Returns a complete character set with the given maximum.
	 *
	 * @param maximum The greatest code point which will be element of the set.
	 */
	static all(maximum: number): CharSet {
		let allSet = allCache.get(maximum);
		if (allSet === undefined) {
			allSet = new CharSet(maximum, [{ min: 0, max: maximum }]);
			allCache.set(maximum, allSet);
		}
		return allSet;
	}

	private checkCompatibility(value: CharSet): void {
		if (value.maximum !== this.maximum) {
			throw new RangeError(
				`The maximum of the other set (${value.maximum}) ` +
					`has to be equal the maximum of this set (${this.maximum}).`
			);
		}
	}

	private toRanges(value: CharSet): readonly CharRange[];
	private toRanges(value: CharSet | Iterable<CharRange>): Iterable<CharRange>;
	private toRanges(value: CharSet | Iterable<CharRange>): Iterable<CharRange> {
		if (value instanceof CharSet) {
			this.checkCompatibility(value);
			return value.ranges;
		} else {
			return value;
		}
	}

	private checkRange(range: CharRange): CharRange {
		if (range.min < 0 || range.min > range.max || range.max > this.maximum)
			throw new RangeError(`min=${range.min} has to be >= 0 and <= max.`);
		if (range.max > this.maximum) throw new RangeError(`max=${range.max} has to be <= maximum=${this.maximum}.`);
		return range;
	}

	equals(other: CharSet): boolean {
		if (other === this) return true;
		if (!(other instanceof CharSet)) return false;
		if (this.maximum !== other.maximum) return false;
		if (this.ranges.length !== other.ranges.length) return false;

		for (let i = 0, l = this.ranges.length; i < l; i++) {
			const thisR = this.ranges[i];
			const otherR = other.ranges[i];
			if (thisR.min !== otherR.min || thisR.max !== otherR.max) return false;
		}
		return true;
	}
	compare(other: CharSet): number {
		if (other === this) return 0;
		if (!(other instanceof CharSet)) return -1;
		if (this.maximum !== other.maximum) return this.maximum - other.maximum;

		// we want to guarantee that disjoint character sets are sorted by their smallest character.
		if (this.isEmpty) return other.isEmpty ? 0 : -1;
		if (other.isEmpty) return 1;
		if (this.ranges[0].min !== other.ranges[0].min) return this.ranges[0].min - other.ranges[0].min;

		if (this.ranges.length !== other.ranges.length) return this.ranges.length - other.ranges.length;

		for (let i = 0, l = this.ranges.length; i < l; i++) {
			const thisR = this.ranges[i];
			const otherR = other.ranges[i];
			if (thisR.min !== otherR.min) return thisR.min - otherR.min;
			if (thisR.max !== otherR.max) return thisR.max - otherR.max;
		}
		return 0;
	}

	negate(): CharSet {
		return new CharSet(this.maximum, negateRanges(this.ranges, this.maximum));
	}

	union(...data: (Iterable<CharRange> | CharSet)[]): CharSet {
		const first = data[0];
		if (data.length === 1 && first instanceof CharSet) {
			this.checkCompatibility(first);
			if (first.ranges.length === 0) {
				return this;
			} else {
				return new CharSet(this.maximum, unionRanges(this.ranges, first.ranges));
			}
		}

		const newRanges: CharRange[] = this.ranges.slice();
		for (const rangesOrSet of data) {
			for (const range of this.toRanges(rangesOrSet)) {
				newRanges.push(this.checkRange(range));
			}
		}

		optimizeRanges(newRanges);
		return new CharSet(this.maximum, newRanges);
	}

	intersect(set: CharSet): CharSet;
	intersect(ranges: Iterable<CharRange>): CharSet;
	intersect(data: Iterable<CharRange> | CharSet): CharSet {
		let other: CharSet;
		if (data instanceof CharSet) {
			this.checkCompatibility(data);
			other = data;
		} else {
			// will be slower because the data has to be sorted and optimized which is done in O(n log n)
			other = CharSet.empty(this.maximum).union(data);
		}

		const newRanges = intersectRanges(this.ranges, other.ranges);

		if (newRanges.length === 0) {
			return CharSet.empty(this.maximum);
		} else {
			return new CharSet(this.maximum, newRanges);
		}
	}

	without(set: CharSet): CharSet;
	without(ranges: Iterable<CharRange>): CharSet;
	without(data: Iterable<CharRange> | CharSet): CharSet {
		let other;
		if (data instanceof CharSet) {
			this.checkCompatibility(data);
			other = data;
		} else {
			other = CharSet.empty(this.maximum).union(data);
		}

		const newRanges = withoutRanges(this.ranges, other.ranges);

		if (newRanges.length === 0) {
			return CharSet.empty(this.maximum);
		} else {
			return new CharSet(this.maximum, newRanges);
		}
	}

	has(character: number): boolean {
		return hasEveryOfRange(this.ranges, { min: character, max: character });
	}

	isSupersetOf(other: CharSet | CharRange): boolean {
		if (!(other instanceof CharSet)) {
			return hasEveryOfRange(this.ranges, other);
		}

		// runs in O(this.ranges.length + other.ranges.length)

		const thisRanges = this.ranges;
		const otherRanges = other.ranges;

		let i = 0;
		let j = 0;
		let thisItem = thisRanges[i];
		let otherItem = otherRanges[j];

		// try to disprove that other this the smaller set
		// we search for any character in other which is not in this

		while (thisItem && otherItem) {
			if (thisItem.min <= otherItem.min && thisItem.max >= otherItem.max) {
				// if thisItem fully contains otherItem
				otherItem = otherRanges[++j];
			} else if (thisItem.max < otherItem.min) {
				// [thisItem] ... [otherItem]
				thisItem = thisRanges[++i];
			} else {
				// thisItem and otherItem partially overlap
				// or thisItem is after otherItem
				return false;
			}
		}

		// otherItem is still defined that there are some chars in other which are not in this
		return !otherItem;
	}
	isSubsetOf(other: CharSet | CharRange): boolean {
		if (other instanceof CharSet) {
			return other.isSupersetOf(this);
		} else {
			if (this.isEmpty) {
				return true;
			} else {
				return other.min <= this.ranges[0].min && this.ranges[this.ranges.length - 1].max <= other.max;
			}
		}
	}

	/**
	 * Returns whether this set and the given set (or range) are disjoint.
	 *
	 * @param other
	 */
	isDisjointWith(other: CharSet | CharRange): boolean {
		return this.commonCharacter(other) === undefined;
	}

	/**
	 * Returns any one of the common characters of this set and the given set or range.
	 *
	 * If this character set is disjoint with the given character set/range, then `undefined` will be returned.
	 *
	 * @param other
	 */
	commonCharacter(other: CharSet | CharRange): number | undefined {
		if (!(other instanceof CharSet)) {
			return commonCharacterOfRange(this.ranges, other);
		}

		// runs in O(this.ranges.length + other.ranges.length)

		const thisRanges = this.ranges;
		const otherRanges = other.ranges;

		let i = 0;
		let j = 0;
		let thisItem = thisRanges[i];
		let otherItem = otherRanges[j];

		while (thisItem && otherItem) {
			if (otherItem.max < thisItem.min) {
				// [otherItem] ... [thisItem]
				otherItem = otherRanges[++j];
			} else if (thisItem.max < otherItem.min) {
				// [thisItem] ... [otherItem]
				thisItem = thisRanges[++i];
			} else {
				// thisItem and otherItem have at least one character in common
				return Math.max(thisItem.min, otherItem.min);
			}
		}

		return undefined;
	}
}

function hasEveryOfRange(ranges: readonly CharRange[], range: CharRange): boolean {
	// runs in O(log(ranges.length))

	const l = ranges.length;
	const { min, max } = range;

	// this is empty
	if (l == 0) return false;

	// out of range
	if (min < ranges[0].min || max > ranges[l - 1].max) return false;

	// the out of range check is enough in this case
	if (l == 1) return true;

	let low = 0; // inclusive
	let high = l; // exclusive
	while (low < high) {
		const m = low + ((high - low) >> 1);
		const mRange = ranges[m];
		const mMin = mRange.min;

		if (mMin == min) {
			return max <= mRange.max;
		} else if (mMin < min) {
			if (max <= mRange.max) return true;
			low = m + 1;
		} /* if (mMin > min) */ else {
			high = m;
		}
	}

	return false;
}

function commonCharacterOfRange(ranges: readonly CharRange[], range: CharRange): number | undefined {
	// runs in O(log(ranges.length))

	const l = ranges.length;
	const { min, max } = range;

	// this is empty
	if (l == 0) return undefined;

	// out of range
	if (max < ranges[0].min || min > ranges[l - 1].max) return undefined;

	let low = 0; // inclusive
	let high = l; // exclusive
	while (low < high) {
		const m = low + ((high - low) >> 1);
		const mRange = ranges[m];
		const mMin = mRange.min;

		if (mMin == min) {
			return min; // range.min is in this set
		} else if (mMin < min) {
			if (min <= mRange.max) return min;
			low = m + 1;
		} /* if (mMin > min) */ else {
			if (mMin <= max) return mMin;
			high = m;
		}
	}

	return undefined;
}

function intersectRanges(a: readonly CharRange[], b: readonly CharRange[]): CharRange[] {
	// intersection done in O(n+m)
	const newRanges: CharRange[] = [];

	let aIndex = 0;
	let bIndex = 0;
	let aRange: CharRange | undefined = a[aIndex];
	let bRange: CharRange | undefined = b[bIndex];
	while (aRange && bRange) {
		// skip if thisR and otherR are disjoint
		if (aRange.max < bRange.min) {
			aRange = a[++aIndex];
			continue;
		}
		if (bRange.max < aRange.min) {
			bRange = b[++bIndex];
			continue;
		}

		// thisR and otherR overlap in at least one character

		// add intersection
		newRanges.push({ min: Math.max(aRange.min, bRange.min), max: Math.min(aRange.max, bRange.max) });

		// advance one the one with the lower max or both if their max is the same
		if (aRange.max < bRange.max) {
			aRange = a[++aIndex];
		} else if (bRange.max < aRange.max) {
			bRange = b[++bIndex];
		} else {
			aRange = a[++aIndex];
			bRange = b[++bIndex];
		}
	}

	return newRanges;
}

function unionRanges(a: readonly CharRange[], b: readonly CharRange[]): CharRange[] {
	// merge the sorted ranges in O(n+m)
	const newRanges: CharRange[] = [];

	let aIndex = 0;
	let bIndex = 0;
	let aRange: CharRange | undefined = a[aIndex];
	let bRange: CharRange | undefined = b[bIndex];
	while (aRange && bRange) {
		if (aRange.min <= bRange.min) {
			newRanges.push(aRange);
			aRange = a[++aIndex];
		} /* if (otherR.min < thisR.min) */ else {
			newRanges.push(bRange);
			bRange = b[++bIndex];
		}
	}

	// append rest
	for (; aRange; aRange = a[++aIndex]) {
		newRanges.push(aRange);
	}
	for (; bRange; bRange = b[++bIndex]) {
		newRanges.push(bRange);
	}

	// optimize
	optimizeSortedRanges(newRanges);

	return newRanges;
}

function withoutRanges(a: readonly CharRange[], b: readonly CharRange[]): CharRange[] {
	// a without b in O(n+m)
	const newRanges: CharRange[] = [];

	let aIndex = 0;
	let bIndex = 0;
	let aRange: CharRange | undefined = a[aIndex];
	let bRange: CharRange | undefined = b[bIndex];
	while (aRange && bRange) {
		if (aRange.max < bRange.min) {
			// disjoint and aRange is before bRange
			newRanges.push(aRange);
			aRange = a[++aIndex];
		} else if (bRange.max < aRange.min) {
			// disjoint and bRange is before aRange
			bRange = b[++bIndex];
		} else {
			// they overlap
			if (aRange.min < bRange.min) {
				newRanges.push({ min: aRange.min, max: bRange.min - 1 });
				if (bRange.max < aRange.max) {
					// [aRange.min ...[bRange]... aRange.max]
					aRange = { min: bRange.max + 1, max: aRange.max };
					bRange = b[++bIndex];
				} else {
					// [aRange.min ...{bRange.min ... aRange.max] bRange.max}
					aRange = a[++aIndex];
				}
			} else {
				if (aRange.max > bRange.max) {
					// [bRange.min ...{aRange.min ... bRange.max] aRange.max}
					aRange = { min: bRange.max + 1, max: aRange.max };
					bRange = b[++bIndex];
				} else {
					// [bRange.min ...[aRange]... bRange.max]
					aRange = a[++aIndex];
				}
			}
		}
	}

	// append rest
	for (; aRange; aRange = a[++aIndex]) {
		newRanges.push(aRange);
	}

	return newRanges;

	//return intersectRanges(a, negateRanges(b, maximum));
}

/**
 * This optimizes the given ranges in O(n) time.
 *
 * @param ranges
 */
function optimizeSortedRanges(ranges: CharRange[]): void {
	let deleteCount = 0;
	for (let i = 0, max = ranges.length - 1; i < max; i++) {
		const current = ranges[i - deleteCount];
		const next = ranges[i + 1];

		if (current.max >= next.max) {
			// current completely contains next.
			deleteCount++;
		} else if (next.min <= current.max + 1) {
			// overlapping or adjacent.
			ranges[i - deleteCount] = { min: current.min, max: next.max };
			deleteCount++;
		} else {
			ranges[i - deleteCount + 1] = next;
		}
	}

	if (deleteCount) {
		ranges.length = ranges.length - deleteCount;
	}
}

/**
 * Given an array of character ranges, it will remove any duplicates and join overlapping and adjacent ranges.
 *
 * While the array itself will be modified, the range objects in the array will not.
 *
 * @param ranges
 */
function optimizeRanges(ranges: CharRange[]): void {
	// runs in O(n * log(n)), n = ranges.length

	ranges.sort((a, b) => a.min - b.min);
	optimizeSortedRanges(ranges);
}

/**
 * Given an array of optimized character ranges, it will return an iterable of character ranges that matches the
 * complete of the given ranges.
 *
 * @param ranges
 * @param maximum
 */
function negateRanges(ranges: readonly CharRange[], maximum: number): CharRange[] {
	// runs in O(ranges.length)

	if (ranges.length === 0) {
		return [{ min: 0, max: maximum }];
	} else {
		const result: CharRange[] = [];

		const first = ranges[0];
		const last = ranges[ranges.length - 1];
		if (first.min > 0) {
			result.push({ min: 0, max: first.min - 1 });
		}
		for (let i = 1; i < ranges.length; i++) {
			result.push({ min: ranges[i - 1].max + 1, max: ranges[i].min - 1 });
		}
		if (last.max < maximum) {
			result.push({ min: last.max + 1, max: maximum });
		}

		return result;
	}
}
