/*
Copyright (C) 2013 u.wol@wwu.de

This file is part of ComputationalEconomy.

ComputationalEconomy is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

ComputationalEconomy is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with ComputationalEconomy. If not, see <http://www.gnu.org/licenses/>.
 */

/*
 * Shared helpers of the JavaScript port: enums, MathUtil, a bit-exact port of
 * java.util.Random and a sorted order book replacing java.util.TreeSet.
 */
(function (root) {
	"use strict";

	const CE = (root.CompEcon = root.CompEcon || {});

	/*
	 * enums; ordinal order matches the Java enums, as iteration order over
	 * values() is relevant for the simulation
	 */
	const Sector = { PRIMARY: "PRIMARY", SECONDARY: "SECONDARY", TERTIARY: "TERTIARY" };

	const GOOD_TYPES = [
		{ name: "CLOTHING", wholeNumber: false, durable: false, sector: Sector.SECONDARY },
		{ name: "COAL", wholeNumber: false, durable: false, sector: Sector.PRIMARY },
		{ name: "COTTON", wholeNumber: false, durable: false, sector: Sector.PRIMARY },
		{ name: "FOOD", wholeNumber: false, durable: false, sector: Sector.SECONDARY },
		{ name: "IRON", wholeNumber: false, durable: false, sector: Sector.PRIMARY },
		{ name: "KILOWATT", wholeNumber: false, durable: false, sector: Sector.SECONDARY },
		{ name: "LABOURHOUR", wholeNumber: false, durable: false, sector: Sector.TERTIARY },
		{ name: "MACHINE", wholeNumber: false, durable: true, sector: Sector.SECONDARY },
		{ name: "REALESTATE", wholeNumber: false, durable: false, sector: Sector.SECONDARY },
		{ name: "WHEAT", wholeNumber: false, durable: false, sector: Sector.PRIMARY },
	];
	const GoodType = {};
	GOOD_TYPES.forEach((goodType, ordinal) => {
		goodType.ordinal = ordinal;
		goodType.toString = () => goodType.name;
		GoodType[goodType.name] = goodType;
	});
	GoodType.values = () => GOOD_TYPES;
	GoodType.count = GOOD_TYPES.length;

	const CURRENCIES = [
		{ name: "EURO", iso4217Code: "EUR" },
		{ name: "USDOLLAR", iso4217Code: "USD" },
		{ name: "YEN", iso4217Code: "YEN" },
	];
	const Currency = {};
	CURRENCIES.forEach((currency, ordinal) => {
		currency.ordinal = ordinal;
		currency.toString = () => currency.iso4217Code;
		Currency[currency.name] = currency;
	});
	Currency.values = () => CURRENCIES;
	Currency.formatMoneySum = function (value) {
		if (Number.isNaN(value) || !Number.isFinite(value)) {
			return "" + value;
		}
		if (Math.abs(value) < 1e6) {
			return value.toFixed(2);
		} else if (Math.abs(value) < 1e9) {
			return (value / 1e6).toFixed(2) + " M";
		}
		return (value / 1e9).toFixed(2) + " B";
	};

	const MoneyType = { CENTRALBANK_MONEY: "CENTRALBANK_MONEY", DEPOSITS: "DEPOSITS" };
	const TermType = { LONG_TERM: "LONG_TERM", SHORT_TERM: "SHORT_TERM" };

	/*
	 * MathUtil
	 */
	const EPSILON = 0.00001;
	const ROUND_PRECISION = Math.round(1.0 / EPSILON);

	const MathUtil = {
		/**
		 * Calculates the monthly nominal interest rate for a given effective yearly
		 * interest rate. The Java original computes (11 / 24) in integer arithmetic,
		 * which evaluates to 0; this is preserved for identical model behaviour.
		 */
		calculateMonthlyNominalInterestRate(effectiveInterestRate) {
			return effectiveInterestRate / (1 + Math.trunc(11 / 24) * effectiveInterestRate) / 12;
		},
		equal(value1, value2) {
			if (Number.isNaN(value1) && Number.isNaN(value2)) {
				return true;
			}
			if (isInfinite(value1) && isInfinite(value2)) {
				return true;
			}
			return Math.abs(value1 - value2) <= EPSILON;
		},
		greater(value1, value2) {
			if (Number.isNaN(value1) || Number.isNaN(value2)) {
				return false;
			}
			if (!isInfinite(value1) && isInfinite(value2)) {
				return false;
			}
			if (isInfinite(value1) && !isInfinite(value2)) {
				return true;
			}
			if (isInfinite(value1) && isInfinite(value2)) {
				return false;
			}
			return value1 - EPSILON > value2;
		},
		greaterEqual(value1, value2) {
			return MathUtil.equal(value1, value2) || MathUtil.greater(value1, value2);
		},
		lesser(value1, value2) {
			if (Number.isNaN(value1) || Number.isNaN(value2)) {
				return false;
			}
			if (isInfinite(value1) && !isInfinite(value2)) {
				return false;
			}
			if (!isInfinite(value1) && isInfinite(value2)) {
				return true;
			}
			if (isInfinite(value1) && isInfinite(value2)) {
				return false;
			}
			return value1 + EPSILON < value2;
		},
		lesserEqual(value1, value2) {
			return MathUtil.equal(value1, value2) || MathUtil.lesser(value1, value2);
		},
		nullSafeValue(number) {
			return number === undefined || number === null ? 0.0 : number;
		},
		round(value) {
			if (Number.isNaN(value) || isInfinite(value)) {
				return value;
			}
			return Math.round(value * ROUND_PRECISION) / ROUND_PRECISION;
		},
	};

	function isInfinite(value) {
		return value === Infinity || value === -Infinity;
	}

	/**
	 * Bit-exact port of java.util.Random (48 bit linear congruential generator),
	 * so that the deterministic seed of the Java simulation is reproduced.
	 */
	class JavaRandom {
		constructor(seed) {
			this.seed = (BigInt(seed) ^ 0x5deece66dn) & ((1n << 48n) - 1n);
		}

		next(bits) {
			this.seed = (this.seed * 0x5deece66dn + 0xbn) & ((1n << 48n) - 1n);
			return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)));
		}

		nextInt(bound) {
			if (bound === undefined) {
				return this.next(32);
			}
			if (bound <= 0) {
				throw new Error("bound must be positive");
			}
			if ((bound & -bound) === bound) {
				return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
			}
			let bits;
			let val;
			do {
				bits = this.next(31);
				val = bits % bound;
			} while (((bits - val + (bound - 1)) | 0) < 0);
			return val;
		}

		/**
		 * port of java.util.Collections.shuffle(list, random)
		 */
		shuffle(list) {
			for (let i = list.length; i > 1; i--) {
				const j = this.nextInt(i);
				const tmp = list[i - 1];
				list[i - 1] = list[j];
				list[j] = tmp;
			}
			return list;
		}
	}

	/**
	 * Replacement for the java.util.TreeSet<MarketOrder> of the market order DAO:
	 * orders are kept sorted by price per unit (ascending), then by id. Orders are
	 * stored in blocks of bounded size, so that inserts and deletes in markets with
	 * tens of thousands of offers (e. g. labour hours) stay cheap.
	 */
	const MAX_BLOCK_SIZE = 128;

	function compareMarketOrders(a, b) {
		if (a === b) {
			return 0;
		}
		if (a.pricePerUnit > b.pricePerUnit) {
			return 1;
		}
		if (a.pricePerUnit < b.pricePerUnit) {
			return -1;
		}
		return a.id - b.id;
	}

	class SortedOrderBook {
		constructor() {
			this.blocks = [];
			this.size = 0;
		}

		findBlockIndex(order) {
			// first block whose last element is >= order
			let lo = 0;
			let hi = this.blocks.length - 1;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				const block = this.blocks[mid];
				if (compareMarketOrders(block[block.length - 1], order) < 0) {
					lo = mid + 1;
				} else {
					hi = mid;
				}
			}
			return lo;
		}

		add(order) {
			if (this.blocks.length === 0) {
				this.blocks.push([order]);
				this.size = 1;
				return;
			}
			const blockIndex = this.findBlockIndex(order);
			const block = this.blocks[blockIndex];
			let lo = 0;
			let hi = block.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (compareMarketOrders(block[mid], order) < 0) {
					lo = mid + 1;
				} else {
					hi = mid;
				}
			}
			if (block[lo] === order) {
				return;
			}
			block.splice(lo, 0, order);
			this.size++;
			if (block.length > MAX_BLOCK_SIZE) {
				this.blocks.splice(blockIndex + 1, 0, block.splice(MAX_BLOCK_SIZE >> 1));
			}
		}

		remove(order) {
			if (this.blocks.length === 0) {
				return false;
			}
			const blockIndex = this.findBlockIndex(order);
			const block = this.blocks[blockIndex];
			let index = -1;
			let lo = 0;
			let hi = block.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (compareMarketOrders(block[mid], order) < 0) {
					lo = mid + 1;
				} else {
					hi = mid;
				}
			}
			if (block[lo] === order) {
				index = lo;
			}
			if (index === -1) {
				// NaN prices break the ordering -> linear fallback
				return this.removeLinear(order);
			}
			this.removeAt(blockIndex, index);
			return true;
		}

		removeLinear(order) {
			for (let b = 0; b < this.blocks.length; b++) {
				const index = this.blocks[b].indexOf(order);
				if (index !== -1) {
					this.removeAt(b, index);
					return true;
				}
			}
			return false;
		}

		removeAt(blockIndex, index) {
			const block = this.blocks[blockIndex];
			block.splice(index, 1);
			this.size--;
			if (block.length === 0) {
				this.blocks.splice(blockIndex, 1);
			}
		}

		first() {
			return this.blocks.length > 0 ? this.blocks[0][0] : undefined;
		}

		*[Symbol.iterator]() {
			for (const block of this.blocks) {
				for (const order of block) {
					yield order;
				}
			}
		}

		/**
		 * calls the visitor in ascending order until it returns false
		 */
		forEachUntil(visitor) {
			for (let b = 0; b < this.blocks.length; b++) {
				const block = this.blocks[b];
				for (let i = 0; i < block.length; i++) {
					if (visitor(block[i]) === false) {
						return;
					}
				}
			}
		}

		toArray() {
			const result = [];
			for (const block of this.blocks) {
				for (const order of block) {
					result.push(order);
				}
			}
			return result;
		}
	}

	/**
	 * array based set with O(1) random access, insert and delete
	 */
	class IndexedList {
		constructor() {
			this.items = [];
			this.indexes = new Map();
		}

		add(item) {
			if (!this.indexes.has(item)) {
				this.indexes.set(item, this.items.length);
				this.items.push(item);
			}
		}

		remove(item) {
			const index = this.indexes.get(item);
			if (index === undefined) {
				return;
			}
			const last = this.items.pop();
			if (last !== item) {
				this.items[index] = last;
				this.indexes.set(last, index);
			}
			this.indexes.delete(item);
		}

		get length() {
			return this.items.length;
		}
	}

	Object.assign(CE, {
		GoodType,
		Sector,
		Currency,
		MoneyType,
		TermType,
		MathUtil,
		JavaRandom,
		SortedOrderBook,
		IndexedList,
	});
})(typeof self !== "undefined" ? self : globalThis);
