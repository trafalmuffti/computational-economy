/*
 * Tests of the asm.js kernels, ported from the Java unit tests
 * (CESFunctionTest, CobbDouglasFunctionTest).
 *
 *   node --allow-natives-syntax web/test/kernels.test.js
 */
"use strict";

const path = require("path");
const assert = require("assert");
globalThis.self = globalThis;
for (const file of ["util.js", "kernels.js", "config.js", "engine.js", "stats.js"]) {
	require(path.join(__dirname, "..", "js", file));
}
const CE = globalThis.CompEcon;
const { ConvexFunction, FunctionKind, CompEconAsmModule } = CE.Kernels;
const { GoodType, SortedOrderBook } = CE;
const epsilon = 0.01;

function near(actual, expected, message) {
	assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: expected ${expected}, got ${actual}`);
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("V8 validates the module as asm.js", () => {
	let isAsm;
	try {
		isAsm = new Function("m", "return %IsAsmWasmCode(m)")(CompEconAsmModule);
	} catch (e) {
		console.log("    (skipped: run node with --allow-natives-syntax)");
		return;
	}
	assert.strictEqual(isAsm, true);
});

test("CES, three goods, fixed prices: analytical = iterative", () => {
	const ces = new ConvexFunction(FunctionKind.CES, [GoodType.KILOWATT, GoodType.COTTON, GoodType.WHEAT],
			[0.1, 0.2, 0.7], 1.0, -0.5, 0.4);
	const prices = [1.0, 3.0, 2.0].map((fixedPrice) => ({ fixedPrice }));
	const analytical = ces.calculateOutputMaximizingInputs(prices, 10.0, 500, 0.0000001).bundle;
	near(analytical[0], 0.373, "KILOWATT");
	near(analytical[1], 0.166, "COTTON");
	near(analytical[2], 4.565, "WHEAT");
	// iterative: fixed prices as single-order books with unlimited amounts
	const books = [1.0, 3.0, 2.0].map((price) => {
		const book = new SortedOrderBook();
		book.add({ id: 1, pricePerUnit: price, amount: 1e9 });
		return { orderBook: book };
	});
	const iterative = ces.calculateOutputMaximizingInputs(books, 10.0, 500, 0.0000001).bundle;
	analytical.forEach((amount, i) => near(iterative[i], amount, "iterative input " + i));
});

test("CES, NaN price: unavailable input is not bought", () => {
	const ces = new ConvexFunction(FunctionKind.CES, [GoodType.COAL, GoodType.KILOWATT, GoodType.WHEAT],
			[0.1, 0.3, 0.6], 1.0, -0.5, 0.4);
	const bundle = ces.calculateOutputMaximizingInputs([NaN, 1.0, 2.0].map((fixedPrice) => ({ fixedPrice })), 10.0,
			500, 0.0000001).bundle;
	near(bundle[0], 0.0, "COAL");
	near(bundle[1], 3.333, "KILOWATT");
	near(bundle[2], 3.333, "WHEAT");
});

test("Cobb-Douglas, fixed prices: x_i = b * e_i / p_i", () => {
	const cd = new ConvexFunction(FunctionKind.COBB_DOUGLAS, [GoodType.WHEAT, GoodType.COAL], [0.4, 0.6], 1.0);
	const bundle = cd.calculateOutputMaximizingInputs([2.0, 3.0].map((fixedPrice) => ({ fixedPrice })), 10.0, 500,
			0.0000001).bundle;
	near(bundle[0], 2.0, "WHEAT");
	near(bundle[1], 2.0, "COAL");
	near(cd.f([2.0, 2.0]), 2.0, "output");
});

test("CES, market step prices: marginal outputs per price are equal", () => {
	const ces = new ConvexFunction(FunctionKind.CES, [GoodType.KILOWATT, GoodType.WHEAT], [0.4, 0.6], 1.0, -0.5, 0.4);
	const book = (offers) => {
		const b = new SortedOrderBook();
		offers.forEach(([amount, price], id) => b.add({ id, pricePerUnit: price, amount }));
		return { orderBook: b };
	};
	const books = [book([[2.0, 1.0], [5.0, 2.0]]), book([[2.0, 1.0], [3.0, 2.0]])];
	const result = ces.calculateOutputMaximizingInputs(books, 10.0, 500, 0.0000001);
	assert.strictEqual(result.terminationCause, "BUDGET_PLANNED");
	near(result.budgetSpent, 10.0, "budget spent");
	const marginalPrice = (offers, x) => {
		let until = 0;
		for (const [amount, price] of offers) {
			if (until + amount >= x) return price;
			until += amount;
		}
		return NaN;
	};
	const perPrice0 = ces.partialDerivative(result.bundle, 0) / marginalPrice([[2, 1], [5, 2]], result.bundle[0]);
	const perPrice1 = ces.partialDerivative(result.bundle, 1) / marginalPrice([[2, 1], [3, 2]], result.bundle[1]);
	assert.ok(Math.abs(perPrice0 - perPrice1) / perPrice0 < 0.05, `${perPrice0} vs ${perPrice1}`);
});

test("java.util.Random port reproduces Java's sequence for seed 100", () => {
	const random = new CE.JavaRandom(100);
	// values of new java.util.Random(100).nextInt(), nextInt(10), nextInt(16)
	assert.deepStrictEqual([random.nextInt(), random.nextInt(10), random.nextInt(16)], [-1193959466, 0, 3]);
});

test("simulation runs 20 days without event errors", () => {
	const statistics = new CE.Statistics();
	const simulation = new CE.Simulation(new CE.Configuration("interdependencies", {}, 0.05), statistics);
	simulation.constructAgentsFromConfiguration();
	for (let hour = 0; hour < 24 * 20; hour++) {
		simulation.nextHour();
	}
	assert.strictEqual(simulation.timeSystem.eventErrors, 0);
	assert.strictEqual(statistics.days.length, 20);
	assert.ok(Number.isFinite(statistics.model(CE.Currency.EURO).series("priceIndex").at(-1)));
});

let failed = 0;
for (const [name, fn] of tests) {
	try {
		fn();
		console.log("ok   " + name);
	} catch (e) {
		failed++;
		console.log("FAIL " + name + "\n     " + e.message);
	}
}
process.exit(failed > 0 ? 1 : 0);
