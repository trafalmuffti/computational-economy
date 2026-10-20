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
 * Numerical kernels of the simulation written in asm.js. This module replaces
 * the Java packages io.github.uwol.compecon.math.* (CES, Cobb-Douglas and root
 * functions, analytical and iterative optimization under budget constraints)
 * and the step price function of MarketPriceFunctionImpl. These are the hot
 * paths of the simulation: every household and every factory runs one of
 * these optimizations per simulated day.
 *
 * Heap layout (byte offsets):
 *
 *     0 .. 255   scalar results (budget spent)
 *   256 .. 511   coefficients / exponents of input i (double)
 *   512 .. 767   bundle of inputs (double), input / output
 *   768 .. 1023  capital / inventory of input i (double)
 *  1024 .. 1279  fixed price of input i (double)
 *  1280 .. 1535  price function cursor: amount until current order (double)
 *  1536 .. 1599  price function: byte offset of first order of input i (int)
 *  1600 .. 1663  price function: number of orders of input i, -1 = fixed (int)
 *  1664 .. 1727  price function cursor: index of current order (int)
 *  1728 .. 1791  price function: 1 if the order book has been truncated (int)
 *  4096 ..       order books: (pricePerUnit, amount) pairs sorted by price
 */
(function (root) {
	"use strict";

	function CompEconAsmModule(stdlib, foreign, buffer) {
		"use asm";

		var pow = stdlib.Math.pow;
		var abs = stdlib.Math.abs;
		var imul = stdlib.Math.imul;

		var HF = new stdlib.Float64Array(buffer);
		var HI = new stdlib.Int32Array(buffer);

		// set, if a price function query exceeds a truncated order book
		var overflow = 0;

		/*
		 * MathUtil; min and max propagate NaN like java.lang.Math
		 */

		function min(a, b) {
			a = +a;
			b = +b;
			if (a != a) {
				return +a;
			}
			if (b != b) {
				return +b;
			}
			if (a < b) {
				return +a;
			}
			return +b;
		}

		function max(a, b) {
			a = +a;
			b = +b;
			if (a != a) {
				return +a;
			}
			if (b != b) {
				return +b;
			}
			if (a > b) {
				return +a;
			}
			return +b;
		}

		// x - x is NaN exactly for infinite and NaN values
		function isInf(x) {
			x = +x;
			return ((x == x) & ((x - x) != (x - x))) | 0;
		}

		function mEqual(a, b) {
			a = +a;
			b = +b;
			if ((a != a) & (b != b)) {
				return 1;
			}
			if (isInf(a) | 0) {
				if (isInf(b) | 0) {
					return 1;
				}
			}
			return (+abs(a - b) <= 0.00001) | 0;
		}

		function mGreater(a, b) {
			a = +a;
			b = +b;
			if ((a != a) | (b != b)) {
				return 0;
			}
			if (isInf(a) | 0) {
				return ((isInf(b) | 0) == 0) | 0;
			}
			if (isInf(b) | 0) {
				return 0;
			}
			return (a - 0.00001 > b) | 0;
		}

		function mLesser(a, b) {
			a = +a;
			b = +b;
			if ((a != a) | (b != b)) {
				return 0;
			}
			if (isInf(a) | 0) {
				return 0;
			}
			if (isInf(b) | 0) {
				return 1;
			}
			return (a + 0.00001 < b) | 0;
		}

		function mLesserEqual(a, b) {
			a = +a;
			b = +b;
			return ((mEqual(a, b) | 0) | (mLesser(a, b) | 0)) | 0;
		}

		/*
		 * functions; kind 0 = CES, 1 = Cobb-Douglas, 2 = root
		 */

		/**
		 * CES: y = a * [c_1 * (x_1)^(-r) + ... + c_n * (x_n)^(-r)]^(-h/r) <br />
		 * Cobb-Douglas: y = a * (x_1)^(e_1) * ... * (x_n)^(e_n) <br />
		 * root: y = a * (x_1)^0.5
		 */
		function f(kind, n, a, r, h) {
			kind = kind | 0;
			n = n | 0;
			a = +a;
			r = +r;
			h = +h;
			var i = 0;
			var sum = 0.0;
			var output = 0.0;
			if ((kind | 0) == 0) {
				for (i = 0; (i | 0) < (n | 0); i = (i + 1) | 0) {
					sum = sum + +HF[(256 + (i << 3)) >> 3] * +pow(+HF[(512 + (i << 3)) >> 3], -r);
				}
				return +(a * +pow(sum, (-1.0 * h) / r));
			}
			if ((kind | 0) == 1) {
				output = a;
				for (i = 0; (i | 0) < (n | 0); i = (i + 1) | 0) {
					output = output * +pow(+HF[(512 + (i << 3)) >> 3], +HF[(256 + (i << 3)) >> 3]);
				}
				return +output;
			}
			return +(a * +pow(+HF[512 >> 3], 0.5));
		}

		function partialDerivative(kind, n, j, a, r, h) {
			kind = kind | 0;
			n = n | 0;
			j = j | 0;
			a = +a;
			r = +r;
			h = +h;
			var i = 0;
			var sum = 0.0;
			var exterior = 0.0;
			var interior = 0.0;
			var constant = 0.0;
			var differentialExponent = 0.0;
			var differentialFactor = 0.0;
			if ((kind | 0) == 0) {
				// exterior derivative
				for (i = 0; (i | 0) < (n | 0); i = (i + 1) | 0) {
					sum = sum + +HF[(256 + (i << 3)) >> 3] * +pow(+HF[(512 + (i << 3)) >> 3], -1.0 * r);
				}
				exterior = (-1.0 * h / r) * a * +pow(sum, (-1.0 * h / r) - 1.0);
				// interior derivative
				interior = -1.0 * r * +HF[(256 + (j << 3)) >> 3]
						* +pow(+HF[(512 + (j << 3)) >> 3], (-1.0 * r) - 1.0);
				// Java returns NaN for 0 * Infinity -> return 0
				if (exterior == 0.0) {
					if (isInf(interior) | 0) {
						return 0.0;
					}
				}
				if (interior == 0.0) {
					if (isInf(exterior) | 0) {
						return 0.0;
					}
				}
				return +(exterior * interior);
			}
			if ((kind | 0) == 1) {
				constant = a;
				for (i = 0; (i | 0) < (n | 0); i = (i + 1) | 0) {
					if ((i | 0) != (j | 0)) {
						constant = constant * +pow(+HF[(512 + (i << 3)) >> 3], +HF[(256 + (i << 3)) >> 3]);
					}
				}
				differentialExponent = +HF[(256 + (j << 3)) >> 3] - 1.0;
				differentialFactor = +HF[(256 + (j << 3)) >> 3]
						* +pow(+HF[(512 + (j << 3)) >> 3], differentialExponent);
				if (constant == 0.0) {
					if (isInf(differentialFactor) | 0) {
						return 0.0;
					}
				}
				return +(constant * differentialFactor);
			}
			if ((j | 0) == 0) {
				return +(a * 0.5 * +pow(+HF[512 >> 3], -0.5));
			}
			return 0.0;
		}

		/*
		 * price functions
		 */

		function resetPriceFunction(j) {
			j = j | 0;
			HF[(1280 + (j << 3)) >> 3] = 0.0;
			HI[(1664 + (j << 2)) >> 2] = 0;
		}

		/**
		 * marginal price of the step price function of input j at the given amount,
		 * i. e. price per unit of the market order, in which the amount is located;
		 * NaN, if the markets are sold out at this amount
		 */
		function marginalPrice(j, atAmount) {
			j = j | 0;
			atAmount = +atAmount;
			var count = 0;
			var cursor = 0;
			var base = 0;
			var until = 0.0;
			var amount = 0.0;
			count = HI[(1600 + (j << 2)) >> 2] | 0;
			if ((count | 0) < 0) {
				return +HF[(1024 + (j << 3)) >> 3];
			}
			until = +HF[(1280 + (j << 3)) >> 3];
			cursor = HI[(1664 + (j << 2)) >> 2] | 0;
			// a preceding query has iterated too far -> restart on the first order
			if (until > atAmount) {
				until = 0.0;
				cursor = 0;
			}
			base = HI[(1536 + (j << 2)) >> 2] | 0;
			while ((cursor | 0) < (count | 0)) {
				amount = +HF[(base + (cursor << 4) + 8) >> 3];
				if (until + amount >= atAmount) {
					HF[(1280 + (j << 3)) >> 3] = until;
					HI[(1664 + (j << 2)) >> 2] = cursor;
					return +HF[(base + (cursor << 4)) >> 3];
				}
				until = until + amount;
				cursor = (cursor + 1) | 0;
			}
			if (HI[(1728 + (j << 2)) >> 2] | 0) {
				overflow = 1;
			}
			resetPriceFunction(j);
			return +(0.0 / 0.0);
		}

		/**
		 * @return index of the input with the highest marginal output per marginal
		 *         price; -1, if markets are sold out
		 */
		function findHighestPartialDerivatePerPrice(kind, n, a, r, h) {
			kind = kind | 0;
			n = n | 0;
			a = +a;
			r = +r;
			h = +h;
			var i = 0;
			var optimalInput = -1;
			var highest = 0.0;
			var partial = 0.0;
			var amountToBuy = 0.0;
			var price = 0.0;
			var perPrice = 0.0;
			for (i = 0; (i | 0) < (n | 0); i = (i + 1) | 0) {
				partial = +partialDerivative(kind, n, i, a, r, h);
				amountToBuy = +max(+HF[(512 + (i << 3)) >> 3] - +HF[(768 + (i << 3)) >> 3], 0.0);
				price = +marginalPrice(i, amountToBuy);
				if (price == price) {
					perPrice = partial / price;
					if (perPrice > highest) {
						optimalInput = i;
						highest = perPrice;
					}
				}
			}
			return optimalInput | 0;
		}

		function initializeBundle(n, initializationValueForInputs) {
			n = n | 0;
			initializationValueForInputs = +initializationValueForInputs;
			var i = 0;
			for (i = 0; (i | 0) < (n | 0); i = (i + 1) | 0) {
				HF[(512 + (i << 3)) >> 3] = +HF[(768 + (i << 3)) >> 3] + initializationValueForInputs;
				resetPriceFunction(i);
			}
		}

		function zeroBundle(n) {
			n = n | 0;
			var i = 0;
			for (i = 0; (i | 0) < (n | 0); i = (i + 1) | 0) {
				HF[(512 + (i << 3)) >> 3] = 0.0;
			}
			HF[0 >> 3] = 0.0;
		}

		function cleanupBundle(n, initializationValueForInputs) {
			n = n | 0;
			initializationValueForInputs = +initializationValueForInputs;
			var i = 0;
			for (i = 0; (i | 0) < (n | 0); i = (i + 1) | 0) {
				HF[(512 + (i << 3)) >> 3] = +HF[(512 + (i << 3)) >> 3] - initializationValueForInputs;
			}
		}

		function inputsAreUnavailable(n) {
			n = n | 0;
			var i = 0;
			var price = 0.0;
			for (i = 0; (i | 0) < (n | 0); i = (i + 1) | 0) {
				resetPriceFunction(i);
				if (+HF[(768 + (i << 3)) >> 3] <= 0.0) {
					price = +marginalPrice(i, 0.0);
					if (price != price) {
						return 1;
					}
				}
			}
			return 0;
		}

		/**
		 * Port of ConvexProductionFunctionImpl.calculateProfitMaximizingProductionFactorsIterative:
		 * calculates the profit maximizing production plan based on the common
		 * microeconomical marginal calculus. The resulting bundle is stored in the
		 * bundle heap region, the budget spent at byte offset 0.
		 *
		 * @return termination cause: 0 = BUDGET_PLANNED, 1 =
		 *         ESTIMATED_REVENUE_PER_UNIT_ZERO, 2 = INPUT_FACTOR_UNAVAILABLE, 3 =
		 *         MARGINAL_REVENUE_EXCEEDED, 4 = MAX_OUTPUT_EXCEEDED, 5 =
		 *         NO_INPUT_AVAILABLE
		 */
		function profitMaximizingProductionFactors(kind, n, a, r, h, needsAllInputsNonZero, priceOfProducedGoodType,
				budget, maxOutput, margin, numberOfIterations, initializationValue) {
			kind = kind | 0;
			n = n | 0;
			a = +a;
			r = +r;
			h = +h;
			needsAllInputsNonZero = needsAllInputsNonZero | 0;
			priceOfProducedGoodType = +priceOfProducedGoodType;
			budget = +budget;
			maxOutput = +maxOutput;
			margin = +margin;
			numberOfIterations = numberOfIterations | 0;
			initializationValue = +initializationValue;
			var initializationValueForInputs = 0.0;
			var budgetSpent = 0.0;
			var budgetPerIteration = 0.0;
			var optimalInput = 0;
			var oldAmount = 0.0;
			var priceRelevantAmount = 0.0;
			var marginalPriceOfOptimalInput = 0.0;
			var additionalAmount = 0.0;
			var estimatedMarginalRevenue = 0.0;
			var marginalOutput = 0.0;
			var marginalPricePerOutput = 0.0;
			var newOutput = 0.0;
			var cause = 0;
			overflow = 0;
			/*
			 * special cases
			 */
			if (inputsAreUnavailable(n) | 0) {
				if (needsAllInputsNonZero) {
					zeroBundle(n);
					return 2;
				}
			}
			if (mLesserEqual(budget, 0.0) | 0) {
				zeroBundle(n);
				return 0;
			}
			if (mLesserEqual(priceOfProducedGoodType, 0.0) | 0) {
				zeroBundle(n);
				return 1;
			}
			/*
			 * initialization
			 */
			if (needsAllInputsNonZero) {
				initializationValueForInputs = initializationValue;
			}
			initializeBundle(n, initializationValueForInputs);
			/*
			 * iterative calculation of maximizing inputs
			 */
			budgetPerIteration = budget / +(imul(n, numberOfIterations) | 0);
			while (1) {
				// would this iteration lead to overspending of the budget?
				if (mGreater(budgetSpent + budgetPerIteration, budget) | 0) {
					cause = 0;
					break;
				}
				optimalInput = findHighestPartialDerivatePerPrice(kind, n, a, r, h) | 0;
				// no optimal input could be found, i. e. markets are sold out
				if ((optimalInput | 0) < 0) {
					cause = 5;
					break;
				}
				oldAmount = +HF[(512 + (optimalInput << 3)) >> 3];
				priceRelevantAmount = +max(oldAmount - +HF[(768 + (optimalInput << 3)) >> 3], 0.0);
				marginalPriceOfOptimalInput = +marginalPrice(optimalInput, priceRelevantAmount);
				// additional amounts have to grow slowly, so that the solution space is not left
				additionalAmount = +min(budgetPerIteration / marginalPriceOfOptimalInput,
						+max(priceRelevantAmount, initializationValue));
				HF[(512 + (optimalInput << 3)) >> 3] = oldAmount + additionalAmount;
				/*
				 * ensure that marginal revenue > marginal cost with NEW amount
				 */
				estimatedMarginalRevenue = priceOfProducedGoodType / (1.0 + margin);
				marginalOutput = +partialDerivative(kind, n, optimalInput, a, r, h);
				marginalPricePerOutput = marginalPriceOfOptimalInput / marginalOutput;
				if (estimatedMarginalRevenue == estimatedMarginalRevenue) {
					if ((isInf(estimatedMarginalRevenue) | 0) == 0) {
						if (mLesser(estimatedMarginalRevenue, marginalPricePerOutput) | 0) {
							HF[(512 + (optimalInput << 3)) >> 3] = oldAmount;
							cause = 3;
							break;
						}
					}
				}
				newOutput = +f(kind, n, a, r, h);
				if (maxOutput == maxOutput) {
					if (mGreater(newOutput, maxOutput) | 0) {
						HF[(512 + (optimalInput << 3)) >> 3] = oldAmount;
						cause = 4;
						break;
					}
				}
				budgetSpent = budgetSpent + marginalPriceOfOptimalInput * additionalAmount;
			}
			cleanupBundle(n, initializationValueForInputs);
			HF[0 >> 3] = budgetSpent;
			return cause | 0;
		}

		/**
		 * Port of ConvexFunctionImpl.calculateOutputMaximizingInputsIterative:
		 * calculates the output maximizing bundle of inputs under a budget
		 * restriction. The inventory region has to be zeroed.
		 *
		 * @return termination cause: 0 = BUDGET_PLANNED, 2 =
		 *         INPUT_FACTOR_UNAVAILABLE, 5 = NO_INPUT_AVAILABLE
		 */
		function outputMaximizingInputs(kind, n, a, r, h, needsAllInputsNonZero, budget, numberOfIterations,
				initializationValue) {
			kind = kind | 0;
			n = n | 0;
			a = +a;
			r = +r;
			h = +h;
			needsAllInputsNonZero = needsAllInputsNonZero | 0;
			budget = +budget;
			numberOfIterations = numberOfIterations | 0;
			initializationValue = +initializationValue;
			var initializationValueForInputs = 0.0;
			var budgetSpent = 0.0;
			var budgetPerIteration = 0.0;
			var optimalInput = 0;
			var oldAmount = 0.0;
			var priceRelevantAmount = 0.0;
			var marginalPriceOfOptimalInput = 0.0;
			var additionalAmount = 0.0;
			var cause = 0;
			overflow = 0;
			if (inputsAreUnavailable(n) | 0) {
				if (needsAllInputsNonZero) {
					zeroBundle(n);
					return 2;
				}
			}
			if (mLesserEqual(budget, 0.0) | 0) {
				zeroBundle(n);
				return 0;
			}
			if (needsAllInputsNonZero) {
				initializationValueForInputs = initializationValue;
			}
			initializeBundle(n, initializationValueForInputs);
			budgetPerIteration = budget / +(imul(n, numberOfIterations) | 0);
			while (1) {
				if (mGreater(budgetSpent + budgetPerIteration, budget) | 0) {
					cause = 0;
					break;
				}
				optimalInput = findHighestPartialDerivatePerPrice(kind, n, a, r, h) | 0;
				if ((optimalInput | 0) < 0) {
					cause = 5;
					break;
				}
				oldAmount = +HF[(512 + (optimalInput << 3)) >> 3];
				priceRelevantAmount = +max(oldAmount - +HF[(768 + (optimalInput << 3)) >> 3], 0.0);
				marginalPriceOfOptimalInput = +marginalPrice(optimalInput, priceRelevantAmount);
				additionalAmount = +min(budgetPerIteration / marginalPriceOfOptimalInput,
						+max(priceRelevantAmount, initializationValue));
				HF[(512 + (optimalInput << 3)) >> 3] = oldAmount + additionalAmount;
				budgetSpent = budgetSpent + marginalPriceOfOptimalInput * additionalAmount;
			}
			cleanupBundle(n, initializationValueForInputs);
			HF[0 >> 3] = budgetSpent;
			return cause | 0;
		}

		/**
		 * analytical solution for the lagrange function of a CES function under
		 * budget constraints and fixed prices: <br />
		 * x_1 = b / [p_1 + p_2 * [(p_1 * c_2) / (p_2 * c_1)]^(1/(r+1)) + ... + p_n
		 * [(p_1 * c_n) / (p_n * c_1)]^(1/(r+1))]
		 */
		function cesOutputMaximizingInputsWithFixedPrices(n, r, budget) {
			n = n | 0;
			r = +r;
			budget = +budget;
			var reference = 0;
			var i = 0;
			var referencePrice = 0.0;
			var currentPrice = 0.0;
			var divisor = 0.0;
			var base = 0.0;
			var optimalAmount = 0.0;
			for (reference = 0; (reference | 0) < (n | 0); reference = (reference + 1) | 0) {
				referencePrice = +HF[(1024 + (reference << 3)) >> 3];
				divisor = referencePrice;
				for (i = 0; (i | 0) < (n | 0); i = (i + 1) | 0) {
					if ((i | 0) != (reference | 0)) {
						currentPrice = +HF[(1024 + (i << 3)) >> 3];
						if ((referencePrice == referencePrice) & (currentPrice == currentPrice)) {
							base = referencePrice * +HF[(256 + (i << 3)) >> 3]
									/ (currentPrice * +HF[(256 + (reference << 3)) >> 3]);
							divisor = divisor + currentPrice * +pow(base, 1.0 / (r + 1.0));
						}
					}
				}
				optimalAmount = budget / divisor;
				if (optimalAmount != optimalAmount) {
					optimalAmount = 0.0;
				}
				HF[(512 + (reference << 3)) >> 3] = optimalAmount;
			}
		}

		/**
		 * analytical solution for the lagrange function of a Cobb-Douglas function
		 * under budget constraints and fixed prices: <br />
		 * x_i = b * e_i / p_i
		 */
		function cobbDouglasOutputMaximizingInputsWithFixedPrices(n, budget) {
			n = n | 0;
			budget = +budget;
			var i = 0;
			var pricesAreNaN = 0;
			var price = 0.0;
			var optimalAmount = 0.0;
			for (i = 0; (i | 0) < (n | 0); i = (i + 1) | 0) {
				price = +HF[(1024 + (i << 3)) >> 3];
				if (price != price) {
					pricesAreNaN = 1;
				}
			}
			for (i = 0; (i | 0) < (n | 0); i = (i + 1) | 0) {
				optimalAmount = +HF[(256 + (i << 3)) >> 3] * budget / +HF[(1024 + (i << 3)) >> 3];
				if (pricesAreNaN | (optimalAmount != optimalAmount)) {
					optimalAmount = 0.0;
				}
				HF[(512 + (i << 3)) >> 3] = optimalAmount;
			}
		}

		function getOverflow() {
			return overflow | 0;
		}

		return {
			f: f,
			partialDerivative: partialDerivative,
			marginalPrice: marginalPrice,
			profitMaximizingProductionFactors: profitMaximizingProductionFactors,
			outputMaximizingInputs: outputMaximizingInputs,
			cesOutputMaximizingInputsWithFixedPrices: cesOutputMaximizingInputsWithFixedPrices,
			cobbDouglasOutputMaximizingInputsWithFixedPrices: cobbDouglasOutputMaximizingInputsWithFixedPrices,
			getOverflow: getOverflow
		};
	}

	/*
	 * JavaScript side: marshalling between simulation objects and the asm.js heap
	 */
	const HEAP_SIZE = 1 << 24;
	const COEF = 256 >> 3;
	const BUNDLE = 512 >> 3;
	const CAPITAL = 768 >> 3;
	const FIXED_PRICE = 1024 >> 3;
	const BOOK_START = 1536 >> 2;
	const BOOK_COUNT = 1600 >> 2;
	const BOOK_TRUNCATED = 1728 >> 2;
	const BOOK_DATA = 4096;
	const MAX_INPUTS = 16;

	const FunctionKind = { CES: 0, COBB_DOUGLAS: 1, ROOT: 2 };
	const TerminationCause = [
		"BUDGET_PLANNED",
		"ESTIMATED_REVENUE_PER_UNIT_ZERO",
		"INPUT_FACTOR_UNAVAILABLE",
		"MARGINAL_REVENUE_EXCEEDED",
		"MAX_OUTPUT_EXCEEDED",
		"NO_INPUT_AVAILABLE",
	];

	const buffer = new ArrayBuffer(HEAP_SIZE);
	const HF = new Float64Array(buffer);
	const HI = new Int32Array(buffer);
	const asm = CompEconAsmModule(root, {}, buffer);

	/**
	 * A convex function over input types, evaluated in asm.js. kind is one of
	 * FunctionKind; coefficients are the CES coefficients, the Cobb-Douglas
	 * exponents or unused for root functions.
	 */
	class ConvexFunction {
		constructor(kind, inputTypes, coefficients, mainCoefficient, substitutionFactor, homogenityFactor) {
			if (inputTypes.length > MAX_INPUTS) {
				throw new Error("too many input types");
			}
			this.kind = kind;
			this.inputTypes = inputTypes;
			this.coefficients = Float64Array.from(coefficients);
			this.mainCoefficient = mainCoefficient;
			this.substitutionFactor = substitutionFactor || 0.0;
			this.homogenityFactor = homogenityFactor || 0.0;
			// Cobb-Douglas functions need all inputs set for partial derivatives
			this.needsAllInputFactorsNonZeroForPartialDerivate = kind === FunctionKind.COBB_DOUGLAS;
		}

		writeCoefficients() {
			HF.set(this.coefficients, COEF);
		}

		writeBundle(bundle) {
			for (let i = 0; i < this.inputTypes.length; i++) {
				HF[BUNDLE + i] = bundle[i];
			}
		}

		readBundle() {
			return Array.from(HF.subarray(BUNDLE, BUNDLE + this.inputTypes.length));
		}

		/**
		 * @param bundle array of amounts in the order of inputTypes
		 */
		f(bundle) {
			this.writeCoefficients();
			this.writeBundle(bundle);
			return asm.f(this.kind, this.inputTypes.length, this.mainCoefficient, this.substitutionFactor,
					this.homogenityFactor);
		}

		partialDerivative(bundle, inputIndex) {
			this.writeCoefficients();
			this.writeBundle(bundle);
			return asm.partialDerivative(this.kind, this.inputTypes.length, inputIndex, this.mainCoefficient,
					this.substitutionFactor, this.homogenityFactor);
		}

		/**
		 * @param priceFunctions array of {fixedPrice} or {orderBook} price
		 *                       functions in the order of inputTypes
		 * @return {bundle, budgetSpent, terminationCause}
		 */
		calculateOutputMaximizingInputs(priceFunctions, budget, numberOfIterations, initializationValue) {
			const n = this.inputTypes.length;
			this.writeCoefficients();
			// analytical solution, if all prices are fixed
			if (priceFunctions.every((priceFunction) => priceFunction.orderBook === undefined)) {
				for (let i = 0; i < n; i++) {
					HF[FIXED_PRICE + i] = priceFunctions[i].fixedPrice;
				}
				if (this.kind === FunctionKind.CES) {
					asm.cesOutputMaximizingInputsWithFixedPrices(n, this.substitutionFactor, budget);
					return { bundle: this.readBundle(), budgetSpent: NaN, terminationCause: null };
				}
				if (this.kind === FunctionKind.COBB_DOUGLAS) {
					asm.cobbDouglasOutputMaximizingInputsWithFixedPrices(n, budget);
					return { bundle: this.readBundle(), budgetSpent: NaN, terminationCause: null };
				}
			}
			return runWithOrderBooks(priceFunctions, budget, () => {
				for (let i = 0; i < n; i++) {
					HF[CAPITAL + i] = 0.0;
				}
				return asm.outputMaximizingInputs(this.kind, n, this.mainCoefficient, this.substitutionFactor,
						this.homogenityFactor, this.needsAllInputFactorsNonZeroForPartialDerivate ? 1 : 0, budget,
						numberOfIterations, initializationValue);
			});
		}

		/**
		 * @param capital array of owned capital in the order of inputTypes
		 * @return {bundle, budgetSpent, terminationCause}
		 */
		calculateProfitMaximizingProductionFactors(priceOfProducedGoodType, priceFunctions, capital, budget, maxOutput,
				margin, numberOfIterations, initializationValue) {
			const n = this.inputTypes.length;
			this.writeCoefficients();
			return runWithOrderBooks(priceFunctions, budget, () => {
				for (let i = 0; i < n; i++) {
					HF[CAPITAL + i] = capital[i];
				}
				return asm.profitMaximizingProductionFactors(this.kind, n, this.mainCoefficient,
						this.substitutionFactor, this.homogenityFactor,
						this.needsAllInputFactorsNonZeroForPartialDerivate ? 1 : 0, priceOfProducedGoodType, budget,
						maxOutput, margin, numberOfIterations, initializationValue);
			});
		}
	}

	/**
	 * Copies the order books of the price functions into the heap. Only the part
	 * of each book is copied, which is plausibly needed for the given budget; if
	 * the optimization walks beyond a truncated book, it is repeated with deeper
	 * books, so that results are identical to an iteration over the full book.
	 */
	function runWithOrderBooks(priceFunctions, budget, run) {
		let depthBudget = Number.isFinite(budget) && budget > 0 ? budget * 2.0 : Infinity;
		while (true) {
			const truncated = writeOrderBooks(priceFunctions, depthBudget);
			const cause = run();
			if (asm.getOverflow() === 0 || !truncated) {
				return {
					bundle: Array.from(HF.subarray(BUNDLE, BUNDLE + priceFunctions.length)),
					budgetSpent: HF[0],
					terminationCause: TerminationCause[cause],
				};
			}
			depthBudget *= 4.0;
		}
	}

	function writeOrderBooks(priceFunctions, depthBudget) {
		const maxOffset = HEAP_SIZE - 16;
		const minOrders = 64;
		let offset = BOOK_DATA;
		let anyTruncated = false;
		for (let i = 0; i < priceFunctions.length; i++) {
			const priceFunction = priceFunctions[i];
			if (priceFunction.orderBook === undefined) {
				HI[BOOK_COUNT + i] = -1;
				HF[FIXED_PRICE + i] = priceFunction.fixedPrice;
				HI[BOOK_TRUNCATED + i] = 0;
				continue;
			}
			HI[BOOK_START + i] = offset;
			let count = 0;
			let cumulatedValue = 0.0;
			let truncated = false;
			priceFunction.orderBook.forEachUntil((marketOrder) => {
				if ((cumulatedValue > depthBudget && count >= minOrders) || offset > maxOffset) {
					truncated = true;
					return false;
				}
				HF[offset >> 3] = marketOrder.pricePerUnit;
				HF[(offset >> 3) + 1] = marketOrder.amount;
				offset += 16;
				count++;
				cumulatedValue += marketOrder.pricePerUnit * marketOrder.amount;
				return true;
			});
			HI[BOOK_COUNT + i] = count;
			HI[BOOK_TRUNCATED + i] = truncated ? 1 : 0;
			anyTruncated = anyTruncated || truncated;
		}
		return anyTruncated;
	}

	const CE = (root.CompEcon = root.CompEcon || {});
	CE.Kernels = { asm, ConvexFunction, FunctionKind, TerminationCause, CompEconAsmModule };
})(typeof self !== "undefined" ? self : globalThis);
