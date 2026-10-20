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
 * Port of io.github.uwol.compecon.engine.log.impl.LogImpl and
 * io.github.uwol.compecon.engine.statistics.ModelRegistry: simulation events are
 * accumulated per currency and day, and stored as daily time series for the
 * dashboard.
 */
(function (root) {
	"use strict";

	const CE = (root.CompEcon = root.CompEcon || {});
	const { GoodType, Currency } = CE;

	const AGENT_TYPES = ["Household", "Factory", "Trader", "CreditBank", "CentralBank", "State"];
	const MAX_DAYS = 365 * 30;

	/**
	 * accumulates a value over a day; for quotients a divisor is accumulated, too
	 */
	class PeriodDataAccumulator {
		constructor(kind) {
			this.kind = kind;
			this.sum = 0;
			this.divisor = 0;
			this.count = 0;
			this.values = [];
		}

		add(amount, divisorAmount) {
			this.sum += amount;
			this.count++;
			if (divisorAmount !== undefined) {
				this.divisor += divisorAmount;
			}
		}

		getValue() {
			if (this.kind === "quotient") {
				return this.divisor === 0.0 ? 0.0 : this.sum / this.divisor;
			}
			if (this.kind === "last") {
				return this.count === 0 ? NaN : this.sum;
			}
			return this.sum;
		}

		set(value) {
			this.sum = value;
			this.count = 1;
		}

		nextPeriod() {
			if (this.values.length >= MAX_DAYS) {
				this.values.shift();
			}
			this.values.push(this.getValue());
			this.sum = 0;
			this.divisor = 0;
			this.count = 0;
		}
	}

	/**
	 * daily open / high / low / close prices and volume of a market (PriceModel)
	 */
	class PriceModel {
		constructor() {
			this.reset();
			this.close = [];
			this.high = [];
			this.low = [];
			this.open = [];
			this.volume = [];
		}

		reset() {
			this.dayOpen = NaN;
			this.dayHigh = NaN;
			this.dayLow = NaN;
			this.dayClose = NaN;
			this.dayVolume = 0;
		}

		tick(price, volume) {
			if (Number.isNaN(this.dayOpen)) {
				this.dayOpen = price;
				this.dayHigh = price;
				this.dayLow = price;
			}
			if (price > this.dayHigh) {
				this.dayHigh = price;
			}
			if (price < this.dayLow) {
				this.dayLow = price;
			}
			this.dayClose = price;
			this.dayVolume += volume;
		}

		nextPeriod() {
			for (const [array, value] of [[this.open, this.dayOpen], [this.high, this.dayHigh], [this.low, this.dayLow],
				[this.close, this.dayClose], [this.volume, this.dayVolume]]) {
				if (array.length >= MAX_DAYS) {
					array.shift();
				}
				array.push(value);
			}
			this.reset();
		}
	}

	const BALANCE_SHEET_FIELDS = ["hardCash", "cashGiroShortTerm", "cashGiroLongTerm", "cashCentralBankShortTerm",
		"cashCentralBankLongTerm", "cashForeignCurrency", "bankLoans", "bonds", "inventoryValue", "loansGiroShortTerm",
		"loansGiroLongTerm", "loansCentralBankShortTerm", "loansCentralBankLongTerm", "financialLiabilities",
		"bankBorrowings"];

	/**
	 * statistics of a national economy (ModelRegistry.NationalEconomyModel)
	 */
	class NationalEconomyModel {
		constructor(currency) {
			this.currency = currency;
			this.accumulators = new Map();
			this.goodTypePrices = GoodType.values().map(() => new PriceModel());
			this.currencyPrices = Currency.values().map(() => new PriceModel());
			this.balanceSheets = this.emptyBalanceSheets();
			this.lastBalanceSheets = this.emptyBalanceSheets();
			this.monetaryTransactions = this.emptyMonetaryTransactions();
			this.lastMonetaryTransactions = this.emptyMonetaryTransactions();
			this.incomes = [];
			this.lastIncomes = [];
			for (const name of ["M0", "M1", "M2", "moneyCirculation", "keyInterestRate", "priceIndex",
				"household.income", "household.consumption", "household.saving", "household.wage",
				"household.dividend", "household.governmentTransfers", "household.utility", "household.retired",
				"household.labourHourCapacity", "household.budget"]) {
				this.accumulator(name, "sum");
			}
			for (const name of ["moneyVelocity", "creditUtilizationRate", "household.consumptionRate",
				"household.savingRate"]) {
				this.accumulator(name, "quotient");
			}
			this.accumulator("household.gini", "last");
			for (const agentType of AGENT_TYPES) {
				this.accumulator("agents." + agentType, "sum");
			}
			for (const goodType of GoodType.values()) {
				for (const name of ["output", "inventory", "offered", "sold", "consumed", "depreciation", "budget"]) {
					this.accumulator(name + "." + goodType.name, "sum");
				}
			}
		}

		emptyBalanceSheets() {
			const result = {};
			for (const agentType of AGENT_TYPES) {
				result[agentType] = { count: 0 };
				for (const field of BALANCE_SHEET_FIELDS) {
					result[agentType][field] = 0;
				}
			}
			return result;
		}

		emptyMonetaryTransactions() {
			const result = {};
			for (const from of AGENT_TYPES) {
				result[from] = {};
				for (const to of AGENT_TYPES) {
					result[from][to] = 0;
				}
			}
			return result;
		}

		accumulator(name, kind) {
			let accumulator = this.accumulators.get(name);
			if (!accumulator) {
				accumulator = new PeriodDataAccumulator(kind || "sum");
				this.accumulators.set(name, accumulator);
			}
			return accumulator;
		}

		add(name, amount, divisorAmount) {
			this.accumulator(name).add(amount, divisorAmount);
		}

		nextPeriod() {
			this.accumulator("moneyVelocity").add(this.accumulator("moneyCirculation").getValue(),
					this.accumulator("M1").getValue());
			this.accumulator("household.gini").set(gini(this.incomes));
			for (const accumulator of this.accumulators.values()) {
				accumulator.nextPeriod();
			}
			for (const priceModel of this.goodTypePrices) {
				priceModel.nextPeriod();
			}
			for (const priceModel of this.currencyPrices) {
				priceModel.nextPeriod();
			}
			this.lastBalanceSheets = this.balanceSheets;
			this.balanceSheets = this.emptyBalanceSheets();
			this.lastMonetaryTransactions = this.monetaryTransactions;
			this.monetaryTransactions = this.emptyMonetaryTransactions();
			this.lastIncomes = this.incomes;
			this.incomes = [];
		}

		series(name) {
			const accumulator = this.accumulators.get(name);
			return accumulator ? accumulator.values : [];
		}
	}

	function gini(values) {
		const n = values.length;
		if (n === 0) {
			return NaN;
		}
		const sorted = Float64Array.from(values).sort();
		let cumulated = 0;
		let weightedSum = 0;
		for (let i = 0; i < n; i++) {
			cumulated += sorted[i];
			weightedSum += (i + 1) * sorted[i];
		}
		if (cumulated <= 0) {
			return NaN;
		}
		return (2 * weightedSum) / (n * cumulated) - (n + 1) / n;
	}

	/**
	 * implements the Log interface of the Java version, which is called by the
	 * simulation on economic events
	 */
	class Statistics {
		constructor() {
			this.models = Currency.values().map((currency) => new NationalEconomyModel(currency));
			this.days = [];
			this.agentCurrentlyActive = null;
			this.simulation = null;
			this.hours = 0;
		}

		attach(simulation) {
			this.simulation = simulation;
		}

		model(currency) {
			return this.models[currency.ordinal];
		}

		/*
		 * time system
		 */

		notifyTimeSystem_nextHour() {
			this.hours++;
		}

		notifyTimeSystem_nextDay(date) {
			// values are recorded with the date of the day they have been accumulated
			if (this.days.length >= MAX_DAYS) {
				this.days.shift();
			}
			this.days.push(date.getTime() - 86400000);
			for (const model of this.models) {
				model.nextPeriod();
			}
		}

		/*
		 * agents
		 */

		setAgentCurrentlyActive(agent) {
			this.agentCurrentlyActive = agent;
		}

		agent_onConstruct() {}

		agent_onDeconstruct(agent) {
			if (this.agentCurrentlyActive === agent) {
				this.agentCurrentlyActive = null;
			}
		}

		agent_onLifesign(agent) {
			this.model(agent.primaryCurrency).add("agents." + agent.agentType, 1);
		}

		agent_onPublishBalanceSheet(agent, balanceSheet) {
			const model = this.model(balanceSheet.referenceCurrency);
			model.add("M0", balanceSheet.hardCash);
			model.add("M1", balanceSheet.hardCash + balanceSheet.cashGiroShortTerm);
			model.add("M2", balanceSheet.hardCash + balanceSheet.cashGiroShortTerm + balanceSheet.cashGiroLongTerm);
			const aggregate = model.balanceSheets[agent.agentType];
			aggregate.count++;
			for (const field of BALANCE_SHEET_FIELDS) {
				aggregate[field] += balanceSheet[field];
			}
		}

		agent_CreditUtilization(agent, creditUtilization, creditCapacity) {
			this.model(agent.primaryCurrency).add("creditUtilizationRate", creditUtilization, creditCapacity);
		}

		agent_onCalculateOutputMaximizingInputsIterative(budget) {
			if (this.agentCurrentlyActive !== null) {
				this.model(this.agentCurrentlyActive.primaryCurrency).add("household.budget", budget);
			}
		}

		/*
		 * banks
		 */

		bank_onTransfer(from, to, currency, value) {
			if (from.owner !== to.owner) {
				const model = this.model(currency);
				model.add("moneyCirculation", value);
				const fromType = from.owner.agentType;
				const toType = to.owner.agentType;
				if (model.monetaryTransactions[fromType] && model.monetaryTransactions[fromType][toType] !== undefined) {
					model.monetaryTransactions[fromType][toType] += value;
				}
			}
		}

		centralBank_KeyInterestRate(currency, keyInterestRate) {
			this.model(currency).add("keyInterestRate", keyInterestRate);
		}

		centralBank_PriceIndex(currency, priceIndex) {
			this.model(currency).add("priceIndex", priceIndex);
		}

		/*
		 * factories
		 */

		factory_AmountSold(currency, goodType, amountSold) {
			this.model(currency).add("sold." + goodType.name, amountSold);
		}

		factory_onCalculateProfitMaximizingProductionFactorsIterative(budget) {
			const agent = this.agentCurrentlyActive;
			if (agent !== null && agent.producedGoodType) {
				this.model(agent.primaryCurrency).add("budget." + agent.producedGoodType.name, budget);
			}
		}

		factory_onCapitalDepreciation(factory, capitalGoodType, depreciation) {
			this.model(factory.primaryCurrency).add("depreciation." + capitalGoodType.name, depreciation);
		}

		factory_onOfferGoodType(currency, goodType, amountOffered, inventory) {
			const model = this.model(currency);
			model.add("offered." + goodType.name, amountOffered);
			model.add("inventory." + goodType.name, inventory);
		}

		factory_onProduction(factory, currency, goodType, output) {
			this.model(currency).add("output." + goodType.name, output);
		}

		/*
		 * households
		 */

		household_AmountSold(currency, labourHoursSold) {
			this.model(currency).add("sold.LABOURHOUR", labourHoursSold);
		}

		household_onIncomeWageDividendTransfersConsumptionSaving(currency, income, consumptionAmount, savingAmount, wage,
				dividend, governmentTransfers) {
			const model = this.model(currency);
			model.add("household.consumption", consumptionAmount);
			model.add("household.income", income);
			model.add("household.consumptionRate", consumptionAmount, income);
			model.add("household.saving", savingAmount);
			model.add("household.savingRate", savingAmount, income);
			model.add("household.wage", wage);
			model.add("household.dividend", dividend);
			model.add("household.governmentTransfers", governmentTransfers);
			model.incomes.push(income);
		}

		household_onOfferResult(currency, labourHoursOffered, labourHourCapacity) {
			const model = this.model(currency);
			model.add("offered.LABOURHOUR", labourHoursOffered);
			model.add("household.labourHourCapacity", labourHourCapacity);
		}

		household_onRetired(household) {
			this.model(household.primaryCurrency).add("household.retired", 1);
		}

		household_onUtility(household, currency, inputTypes, bundle, utility) {
			const model = this.model(currency);
			model.add("household.utility", utility);
			for (let i = 0; i < inputTypes.length; i++) {
				model.add("consumed." + inputTypes[i].name, bundle[i]);
			}
		}

		/*
		 * markets
		 */

		market_onTickGoodType(pricePerUnit, goodType, currency, amount) {
			this.model(currency).goodTypePrices[goodType.ordinal].tick(pricePerUnit, amount);
		}

		market_onTickCurrency(pricePerUnit, commodityCurrency, currency, amount) {
			this.model(currency).currencyPrices[commodityCurrency.ordinal].tick(pricePerUnit, amount);
		}

		pricingBehaviour_onCalculateNewPrice() {}
	}

	CE.Statistics = Statistics;
	CE.AGENT_TYPES = AGENT_TYPES;
	CE.BALANCE_SHEET_FIELDS = BALANCE_SHEET_FIELDS;
})(typeof self !== "undefined" ? self : globalThis);
