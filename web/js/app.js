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
 * Web dashboard, replacing the Swing dashboard of the Java version: runs the
 * simulation in time slices on the main thread and renders its statistics.
 */
(function (root) {
	"use strict";

	const CE = root.CompEcon;
	const { GoodType, Currency, MathUtil, LineChart, formatNumber, AGENT_TYPES } = CE;

	const FRAME_BUDGET_MS = 24;
	const RENDER_INTERVAL_MS = 300;
	const SERIES = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5"];

	const state = {
		simulation: null,
		statistics: null,
		running: true,
		currency: Currency.EURO,
		rangeDays: 0,
		industry: GoodType.FOOD,
		daysPerSecond: 0,
		hourCredit: 0,
		lastFrame: 0,
		lastRender: 0,
		renderedDays: -1,
		dirty: true,
		speedSamples: [],
	};

	const $ = (id) => document.getElementById(id);

	/*
	 * series helpers
	 */

	const model = () => state.statistics.model(state.currency);
	const series = (name) => model().series(name);
	const priceClose = (goodType) => model().goodTypePrices[goodType.ordinal].close;
	const perHousehold = (name) => {
		const values = series(name);
		const households = series("agents.Household");
		return values.map((v, i) => (households[i] > 0 ? v / households[i] : NaN));
	};

	function targetPriceIndexSeries() {
		const config = state.simulation.configuration.centralBankConfig;
		const startYear = state.simulation.timeSystem.startYear;
		const monthly = MathUtil.calculateMonthlyNominalInterestRate(config.inflationTarget);
		return state.statistics.days.map((time) => {
			const date = new Date(time);
			const year = Math.pow(1.0 + config.inflationTarget, date.getUTCFullYear() - startYear);
			const month = Math.pow(1.0 + monthly, date.getUTCMonth()) - 1.0;
			const day = (monthly / 30.0) * date.getUTCDate();
			return config.targetPriceIndex * (year + month + day);
		});
	}

	function otherCurrencies() {
		return Currency.values().filter((currency) => currency !== state.currency);
	}

	/*
	 * chart definitions per dashboard section
	 */

	const CHARTS = {
		markets: [
			{
				title: "Primary goods",
				note: "price per unit",
				series: () => ["COAL", "COTTON", "IRON", "WHEAT"].map((g) => ({ label: g.toLowerCase(), values: () => priceClose(GoodType[g]) })),
			},
			{
				title: "Manufactured goods",
				note: "price per unit",
				series: () => ["CLOTHING", "FOOD", "KILOWATT", "REALESTATE"].map((g) => ({
					label: g === "REALESTATE" ? "real estate" : g.toLowerCase(),
					values: () => priceClose(GoodType[g]),
				})),
			},
			{
				title: "Wage and capital",
				note: "price per labour hour and per machine",
				series: () => [
					{ label: "labour hour", values: () => priceClose(GoodType.LABOURHOUR) },
					{ label: "machine", values: () => priceClose(GoodType.MACHINE) },
				],
			},
			{
				title: "Exchange rates",
				note: () => "price of one unit of foreign currency in " + state.currency.iso4217Code,
				format: "ratio",
				zeroBased: false,
				series: () => otherCurrencies().map((currency) => ({
					label: currency.iso4217Code,
					values: () => model().currencyPrices[currency.ordinal].close,
				})),
			},
		],
		money: [
			{
				title: "Price index",
				note: "weighted marginal prices",
				series: () => [
					{ label: "price index", values: () => series("priceIndex") },
					{ label: "target", values: targetPriceIndexSeries },
				],
			},
			{
				title: "Key interest rate",
				note: "effective, per year",
				format: "percent",
				series: () => [{ label: "key interest rate", values: () => series("keyInterestRate") }],
			},
			{
				title: "Money supply",
				note: "sum over all balance sheets",
				series: () => [
					{ label: "M1", values: () => series("M1") },
					{ label: "M2", values: () => series("M2") },
				],
			},
			{
				title: "Money velocity",
				note: "transfers between agents per day / M1",
				format: "ratio",
				series: () => [{ label: "money velocity", values: () => series("moneyVelocity") }],
			},
			{
				title: "Credit utilization of factories",
				note: "overdraft / credit line",
				format: "percent",
				series: () => [{ label: "credit utilization", values: () => series("creditUtilizationRate") }],
			},
		],
		households: [
			{
				title: "Income sources per household",
				note: "per day",
				series: () => [
					{ label: "wage", values: () => perHousehold("household.wage") },
					{ label: "dividend", values: () => perHousehold("household.dividend") },
					{ label: "transfers", values: () => perHousehold("household.governmentTransfers") },
				],
			},
			{
				title: "Utility per household",
				note: "CES utility of the daily consumption bundle",
				series: () => [{ label: "utility", values: () => perHousehold("household.utility") }],
			},
			{
				title: "Labour market",
				note: "labour hours per day",
				series: () => [
					{ label: "offered", values: () => series("offered.LABOURHOUR") },
					{ label: "sold", values: () => series("sold.LABOURHOUR") },
				],
			},
			{
				title: "Households",
				note: "number of households",
				series: () => [{ label: "households", values: () => series("agents.Household") }],
			},
			{
				title: "Income inequality",
				note: "Gini coefficient of daily household income",
				format: "ratio",
				series: () => [{ label: "Gini coefficient", values: () => series("household.gini") }],
			},
		],
		industries: [
			{
				title: () => "Output and sales · " + industryLabel(state.industry),
				note: "units per day",
				series: () => [
					{ label: "produced", values: () => series("output." + state.industry.name) },
					{ label: "offered", values: () => series("offered." + state.industry.name) },
					{ label: "sold", values: () => series("sold." + state.industry.name) },
				],
			},
			{
				title: () => "Price range · " + industryLabel(state.industry),
				note: "daily low, close and high of settled trades",
				zeroBased: false,
				series: () => {
					const prices = model().goodTypePrices[state.industry.ordinal];
					return [
						{ label: "high", values: () => prices.high },
						{ label: "close", values: () => prices.close },
						{ label: "low", values: () => prices.low },
					];
				},
			},
			{
				title: () => "Production budget · " + industryLabel(state.industry),
				note: "sum over factories, per day",
				series: () => [{ label: "budget", values: () => series("budget." + state.industry.name) }],
			},
			{
				title: () => "Household consumption · " + industryLabel(state.industry),
				note: "units per day",
				series: () => [{ label: "consumed", values: () => series("consumed." + state.industry.name) }],
			},
		],
	};

	function industryLabel(goodType) {
		return goodType === GoodType.REALESTATE ? "real estate" : goodType.name.toLowerCase();
	}

	const charts = [];

	function evaluate(value) {
		return typeof value === "function" ? value() : value;
	}

	function buildCharts() {
		for (const [section, definitions] of Object.entries(CHARTS)) {
			const container = document.querySelector('[data-charts="' + section + '"]');
			for (const definition of definitions) {
				const card = document.createElement("div");
				card.className = "card";
				const head = document.createElement("div");
				head.className = "card-head";
				const titles = document.createElement("div");
				const h3 = document.createElement("h3");
				const note = document.createElement("p");
				note.className = "note";
				titles.append(h3, note);
				const toggle = document.createElement("button");
				toggle.type = "button";
				toggle.className = "chart-table-toggle";
				toggle.textContent = "Table";
				toggle.setAttribute("aria-expanded", "false");
				head.append(titles, toggle);
				const legend = document.createElement("div");
				legend.className = "chart-legend";
				const plot = document.createElement("div");
				plot.className = "chart-plot";
				const table = document.createElement("div");
				table.className = "chart-table";
				table.hidden = true;
				card.append(head, legend, plot, table);
				container.appendChild(card);
				const chart = new LineChart(card, {
					series: [],
					format: definition.format,
					zeroBased: definition.zeroBased,
				});
				charts.push({ definition, chart, h3, note, seriesKey: "" });
			}
		}
	}

	/*
	 * rendering
	 */

	function render() {
		const statistics = state.statistics;
		const times = statistics.days;
		let from = 0;
		if (state.rangeDays > 0) {
			from = Math.max(0, times.length - state.rangeDays);
		}
		const visibleTimes = times.slice(from);
		for (const entry of charts) {
			const { definition, chart } = entry;
			entry.h3.textContent = evaluate(definition.title);
			entry.note.textContent = evaluate(definition.note);
			const seriesDefinitions = definition.series();
			const key = seriesDefinitions.map((s) => s.label).join("|");
			if (key !== entry.seriesKey) {
				chart.setSeries(seriesDefinitions.map((s, i) => ({ label: s.label, color: SERIES[i] })));
				entry.seriesKey = key;
			}
			chart.setData(visibleTimes, seriesDefinitions.map((s) => s.values().slice(from)));
		}
		renderFigures();
		renderTables();
		state.renderedDays = times.length;
	}

	function last(values) {
		for (let i = values.length - 1; i >= 0; i--) {
			if (Number.isFinite(values[i])) {
				return values[i];
			}
		}
		return NaN;
	}

	function change(values, days) {
		const n = values.length;
		if (n <= days) {
			return NaN;
		}
		const now = values[n - 1];
		const before = values[n - 1 - days];
		return before ? now / before - 1 : NaN;
	}

	function renderFigures() {
		const simulation = state.simulation;
		const agents = simulation.countAgents(state.currency);
		const priceIndex = series("priceIndex");
		const figures = [
			{
				label: "Households",
				value: formatNumber(agents.Household),
				sub: agents.Factory + " factories · " + agents.CreditBank + " banks",
			},
			{
				label: "Price index",
				value: formatNumber(last(priceIndex)),
				sub: Number.isFinite(change(priceIndex, 30)) ? signed(change(priceIndex, 30)) + " over 30 days" : "after day 1",
			},
			{
				label: "Key interest rate",
				value: formatNumber(simulation.findCentralBank(state.currency).effectiveKeyInterestRate, "percent"),
				sub: "per year",
			},
			{
				label: "Money supply M1",
				value: formatNumber(last(series("M1"))),
				sub: state.currency.iso4217Code,
			},
			{
				label: "Wage",
				value: formatNumber(last(priceClose(GoodType.LABOURHOUR))),
				sub: state.currency.iso4217Code + " per labour hour",
			},
			{
				label: "Utility per household",
				value: formatNumber(last(perHousehold("household.utility"))),
				sub: "required: " + simulation.configuration.householdConfig.requiredUtilityPerDay,
			},
		];
		const container = $("figures");
		if (container.children.length !== figures.length) {
			container.textContent = "";
			for (let i = 0; i < figures.length; i++) {
				const figure = document.createElement("div");
				figure.className = "figure";
				for (const cls of ["label", "value", "sub"]) {
					const element = document.createElement("span");
					element.className = cls;
					figure.appendChild(element);
				}
				container.appendChild(figure);
			}
		}
		figures.forEach((figure, i) => {
			const element = container.children[i];
			element.children[0].textContent = figure.label;
			element.children[1].textContent = figure.value;
			element.children[2].textContent = figure.sub;
		});
	}

	function signed(ratio) {
		return (ratio >= 0 ? "+" : "−") + Math.abs(ratio * 100).toFixed(1) + " %";
	}

	const AGENT_LABELS = {
		Household: "Households",
		Factory: "Factories",
		Trader: "Traders",
		CreditBank: "Credit banks",
		CentralBank: "Central bank",
		State: "State",
	};

	function renderTables() {
		const balanceSheets = model().lastBalanceSheets;
		const rows = [
			["Agents", (b) => b.count, true],
			["Deposits, short term", (b) => b.cashGiroShortTerm],
			["Deposits, long term", (b) => b.cashGiroLongTerm],
			["Central bank money", (b) => b.cashCentralBankShortTerm + b.cashCentralBankLongTerm],
			["Foreign currency", (b) => b.cashForeignCurrency],
			["Loans granted", (b) => b.bankLoans],
			["Bonds", (b) => b.bonds],
			["Inventory", (b) => b.inventoryValue],
			["Loans taken", (b) => b.loansGiroShortTerm + b.loansGiroLongTerm + b.loansCentralBankShortTerm
					+ b.loansCentralBankLongTerm],
			["Bonds issued", (b) => b.financialLiabilities],
			["Customer deposits", (b) => b.bankBorrowings],
		];
		const table = document.createElement("table");
		const head = table.createTHead().insertRow();
		head.appendChild(document.createElement("th")).textContent = state.currency.iso4217Code;
		for (const agentType of AGENT_TYPES) {
			head.appendChild(document.createElement("th")).textContent = AGENT_LABELS[agentType];
		}
		const body = table.createTBody();
		for (const [label, value, integer] of rows) {
			const row = body.insertRow();
			row.insertCell().textContent = label;
			for (const agentType of AGENT_TYPES) {
				const v = value(balanceSheets[agentType]);
				row.insertCell().textContent = integer ? String(v) : formatNumber(v);
			}
		}
		$("balance-sheets").replaceChildren(table);

		const transactions = model().lastMonetaryTransactions;
		const matrix = document.createElement("table");
		const matrixHead = matrix.createTHead().insertRow();
		matrixHead.appendChild(document.createElement("th")).textContent = "From \\ to";
		for (const to of AGENT_TYPES) {
			matrixHead.appendChild(document.createElement("th")).textContent = AGENT_LABELS[to];
		}
		const matrixBody = matrix.createTBody();
		for (const from of AGENT_TYPES) {
			const row = matrixBody.insertRow();
			row.insertCell().textContent = AGENT_LABELS[from];
			for (const to of AGENT_TYPES) {
				const v = transactions[from][to];
				row.insertCell().textContent = v ? formatNumber(v) : "·";
			}
		}
		$("transactions").replaceChildren(matrix);
	}

	function renderClock() {
		const timeSystem = state.simulation.timeSystem;
		const date = timeSystem.getCurrentDate();
		const hour = String(date.getUTCHours()).padStart(2, "0");
		$("clock-date").textContent = CE.formatDate(date.getTime()) + " · " + hour + ":00";
		const samples = state.speedSamples;
		let rate = "";
		if (state.running && samples.length > 1) {
			const hours = samples[samples.length - 1].hours - samples[0].hours;
			const seconds = (samples[samples.length - 1].time - samples[0].time) / 1000;
			if (seconds > 0) {
				rate = " · " + (hours / 24 / seconds).toFixed(1) + " days/s";
			}
		}
		$("clock-rate").textContent = "day " + timeSystem.dayNumber + rate;
		$("init-phase").hidden = !timeSystem.isInitializationPhase();
	}

	/*
	 * simulation loop
	 */

	function createSimulation() {
		const preset = $("preset").value;
		const scale = parseFloat($("scale").value);
		const statistics = new CE.Statistics();
		const simulation = new CE.Simulation(new CE.Configuration(preset, {}, scale), statistics);
		simulation.constructAgentsFromConfiguration();
		state.simulation = simulation;
		state.statistics = statistics;
		state.renderedDays = -1;
		state.speedSamples = [];
		state.hourCredit = 0;
		// currencies without agents in this model are not offered
		const currencies = Currency.values().filter((currency) =>
			simulation.configuration.householdConfig.number[currency.name] > 0);
		if (!currencies.includes(state.currency)) {
			state.currency = currencies[0];
		}
		buildCurrencyButtons(currencies);
		buildIndustryOptions();
		render();
		renderClock();
	}

	function buildCurrencyButtons(currencies) {
		const container = $("currency");
		container.textContent = "";
		for (const currency of currencies) {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = currency.iso4217Code;
			button.setAttribute("aria-pressed", String(currency === state.currency));
			button.addEventListener("click", () => {
				state.currency = currency;
				for (const other of container.children) {
					other.setAttribute("aria-pressed", String(other === button));
				}
				render();
			});
			container.appendChild(button);
		}
	}

	function buildIndustryOptions() {
		const simulation = state.simulation;
		const select = $("industry");
		const goodTypes = GoodType.values().filter((goodType) => goodType !== GoodType.LABOURHOUR
				&& simulation.inputOutputModel.getProductionFunction(goodType) !== null);
		if (!goodTypes.includes(state.industry)) {
			state.industry = goodTypes[0];
		}
		select.textContent = "";
		for (const goodType of goodTypes) {
			const option = document.createElement("option");
			option.value = goodType.name;
			option.textContent = industryLabel(goodType);
			option.selected = goodType === state.industry;
			select.appendChild(option);
		}
	}

	function setRunning(running) {
		state.running = running;
		$("run").textContent = running ? "Pause" : "Run";
		state.speedSamples = [];
		state.lastFrame = performance.now();
	}

	function stepHours(maxHours, deadline) {
		let hours = 0;
		while (hours < maxHours && performance.now() < deadline) {
			state.simulation.nextHour();
			hours++;
		}
		return hours;
	}

	function frame(now) {
		if (state.running) {
			let maxHours = Infinity;
			if (state.daysPerSecond > 0) {
				state.hourCredit += ((now - state.lastFrame) / 1000) * state.daysPerSecond * 24;
				state.hourCredit = Math.min(state.hourCredit, state.daysPerSecond * 24);
				maxHours = Math.floor(state.hourCredit);
			}
			const hours = stepHours(maxHours, performance.now() + FRAME_BUDGET_MS);
			if (state.daysPerSecond > 0) {
				state.hourCredit -= hours;
			}
			state.speedSamples.push({ time: now, hours: state.statistics.hours });
			if (state.speedSamples.length > 60) {
				state.speedSamples.shift();
			}
		}
		state.lastFrame = now;
		if (now - state.lastRender > RENDER_INTERVAL_MS) {
			if (state.statistics.days.length !== state.renderedDays || state.dirty) {
				render();
				state.dirty = false;
			}
			renderClock();
			state.lastRender = now;
		}
		requestAnimationFrame(frame);
	}

	/*
	 * wiring
	 */

	function init() {
		const presetSelect = $("preset");
		for (const [key, preset] of Object.entries(CE.CONFIGURATION_PRESETS)) {
			const option = document.createElement("option");
			option.value = key;
			option.textContent = preset.title;
			presetSelect.appendChild(option);
		}
		buildCharts();
		createSimulation();

		$("run").addEventListener("click", () => setRunning(!state.running));
		$("step").addEventListener("click", () => {
			setRunning(false);
			const target = state.simulation.timeSystem.dayNumber + 1;
			while (state.simulation.timeSystem.dayNumber < target) {
				state.simulation.nextHour();
			}
			render();
			renderClock();
		});
		$("reset").addEventListener("click", createSimulation);
		presetSelect.addEventListener("change", createSimulation);
		$("scale").addEventListener("change", createSimulation);
		$("speed").addEventListener("change", (event) => {
			state.daysPerSecond = parseFloat(event.target.value);
			state.hourCredit = 0;
		});
		$("industry").addEventListener("change", (event) => {
			state.industry = GoodType[event.target.value];
			render();
		});
		for (const button of $("range").children) {
			button.addEventListener("click", () => {
				state.rangeDays = parseInt(button.dataset.days, 10);
				for (const other of $("range").children) {
					other.setAttribute("aria-pressed", String(other === button));
				}
				render();
			});
		}
		// redraw with theme colors when the theme changes
		const redraw = () => {
			state.dirty = true;
		};
		window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);
		new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

		setRunning(true);
		requestAnimationFrame(frame);
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
})(typeof self !== "undefined" ? self : globalThis);
