/*
 * Runs the simulation headless in Node.js and prints daily key figures.
 *
 *   node web/test/run-headless.js [preset] [days] [agentScale]
 */
"use strict";

const path = require("path");
globalThis.self = globalThis;
for (const file of ["util.js", "kernels.js", "config.js", "engine.js", "stats.js"]) {
	require(path.join(__dirname, "..", "js", file));
}
const CE = globalThis.CompEcon;

const preset = process.argv[2] || "interdependencies";
const days = parseInt(process.argv[3] || "30", 10);
const agentScale = parseFloat(process.argv[4] || "1");

const statistics = new CE.Statistics();
const simulation = new CE.Simulation(new CE.Configuration(preset, {}, agentScale), statistics);
let start = Date.now();
simulation.constructAgentsFromConfiguration();
console.log("constructed agents in", Date.now() - start, "ms");

start = Date.now();
const EUR = CE.Currency.EURO;
const model = statistics.model(EUR);
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(3) : String(x));
for (let day = 0; day < days; day++) {
	const dayStart = Date.now();
	for (let hour = 0; hour < 24; hour++) {
		simulation.nextHour();
	}
	const last = (name) => model.series(name)[model.series(name).length - 1];
	const price = (g) => model.goodTypePrices[CE.GoodType[g].ordinal].close.at(-1);
	if (day % Math.max(1, Math.floor(days / 30)) === 0 || day === days - 1) {
		console.log(`day ${String(day + 1).padStart(4)} ${String(Date.now() - dayStart).padStart(4)}ms`,
			"hh", simulation.householdsByCurrency[0].length,
			"| pIdx", fmt(last("priceIndex")), "rate", fmt(last("keyInterestRate")),
			"| M1", fmt(last("M1")), "| util", fmt(last("household.utility") / simulation.householdsByCurrency[0].length),
			"| LH", fmt(price("LABOURHOUR")), "FOOD", fmt(price("FOOD")), "COAL", fmt(price("COAL")),
			"| outFOOD", fmt(last("output.FOOD")), "| USD/EUR", fmt(model.currencyPrices[1].close.at(-1)));
	}
}
console.log("simulated", days, "days in", Date.now() - start, "ms; event errors:", simulation.timeSystem.eventErrors);
