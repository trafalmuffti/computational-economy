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
 * Port of io.github.uwol.compecon.engine.applicationcontext.Configuration. The
 * presets are the unmodified .properties files of the Java version
 * (src/main/resources/*.configuration.properties).
 */
(function (root) {
	"use strict";

	const CE = (root.CompEcon = root.CompEcon || {});

	const PRESETS = {
		interdependencies: {
			title: "Interdependencies (default)",
			properties: "# -Dconfiguration.properties=interdependencies.configuration.properties\n\nhousehold.EURO.number = 2000\nhousehold.USDOLLAR.number = 2000\nhousehold.YEN.number = 2000\nhousehold.lifespanInDays = 29200\nhousehold.retirementAgeInDays = 23725\n# retirementSaving=true in combination with key interest rate > 0 can cause ad-hoc inflation due to interest on saving deposits\nhousehold.retirementSaving = false\nhousehold.numberOfLabourHoursPerDay = 16\nhousehold.newHouseholdFromAgeInDays = 6570\nhousehold.newHouseholdEveryXDays = 1825\nhousehold.requiredUtilityPerDay = 1.0\nhousehold.daysWithoutUtilityUntilDestructor = 60\nhousehold.maxPricePerUnitMultiplier = 1.0\n\nfactory.capitalDepreciationRatioPerPeriod = 0.001 \n# significantly determining stability of prices; too much money capital -> volatile markets \nfactory.referenceCredit = 10000\nfactory.margin = 0.1\n\nfactory.EURO.IRON.number = 10\nfactory.EURO.COAL.number = 10\nfactory.EURO.COTTON.number = 10\nfactory.EURO.WHEAT.number = 10\nfactory.EURO.FOOD.number = 10\nfactory.EURO.CLOTHING.number = 10\nfactory.EURO.KILOWATT.number = 10\nfactory.EURO.REALESTATE.number = 10\nfactory.EURO.MACHINE.number = 3\n\nfactory.USDOLLAR.IRON.number = 10\nfactory.USDOLLAR.COAL.number = 10\nfactory.USDOLLAR.COTTON.number = 10\nfactory.USDOLLAR.WHEAT.number = 10\nfactory.USDOLLAR.FOOD.number = 10\nfactory.USDOLLAR.CLOTHING.number = 10\nfactory.USDOLLAR.KILOWATT.number = 10\nfactory.USDOLLAR.REALESTATE.number = 10\nfactory.USDOLLAR.MACHINE.number = 3\n\nfactory.YEN.IRON.number = 10\nfactory.YEN.COAL.number = 10\nfactory.YEN.COTTON.number = 10\nfactory.YEN.WHEAT.number = 10\nfactory.YEN.FOOD.number = 10\nfactory.YEN.CLOTHING.number = 10\nfactory.YEN.KILOWATT.number = 10\nfactory.YEN.REALESTATE.number = 10\nfactory.YEN.MACHINE.number = 3\n\ncentralBank.reserveRatio = 0.1\ncentralBank.inflationTarget = 0.02\ncentralBank.targetPriceIndex = 15\n# negative key interest rates can cause abnormal behaviour, e. g. a flow of interest from pension saving bank accounts into the monetary system \n# (which is a problem, as i. e. hoarded money that has been neutralized by credit banks buying state bonds and \n# states buying goods, thereby reintroducing the hoarded money into the monetary system -> expanding M1 -> instable prices)\ncentralBank.minEffectiveKeyInterestRate = 0.0\ncentralBank.maxEffectiveKeyInterestRate = 0.05\ncentralBank.defaultEffectiveKeyInterestRate = 0.02\ncentralBank.statisticalOffice.priceIndexWeights.IRON = 0.125\ncentralBank.statisticalOffice.priceIndexWeights.COAL = 0.125\ncentralBank.statisticalOffice.priceIndexWeights.COTTON = 0.125\ncentralBank.statisticalOffice.priceIndexWeights.WHEAT = 0.125\ncentralBank.statisticalOffice.priceIndexWeights.FOOD = 0.125\ncentralBank.statisticalOffice.priceIndexWeights.CLOTHING = 0.125\ncentralBank.statisticalOffice.priceIndexWeights.KILOWATT = 0.125\ncentralBank.statisticalOffice.priceIndexWeights.REALESTATE = 0.125\n\ncentralBank.EURO.number = 1\ncentralBank.USDOLLAR.number = 1\ncentralBank.YEN.number = 1\n\ncreditBank.EURO.number = 5\ncreditBank.USDOLLAR.number = 5\ncreditBank.YEN.number = 5\ncreditBank.priceChangeIncrement = 0.1\ncreditBank.maxCreditForCurrencyTrading = 100000\ncreditBank.minArbitrageMargin = 0.03\n\ntrader.EURO.number = 10\ntrader.USDOLLAR.number = 10\ntrader.YEN.number = 10\ntrader.arbitrageMargin = 0.2\ntrader.referenceCredit = 10000\n\nstate.EURO.number = 1\nstate.USDOLLAR.number = 1\nstate.YEN.number = 1\nstate.bondMargin = 0.02\n\nagent.balanceSheetPublicationHourType = HOUR_23\n\nbudgetingBehaviour.internalRateOfReturn = 0.05\nbudgetingBehaviour.keyInterestRateTransmissionDamper = 50\n\ninputOutputModel = InputOutputModelInterdependencies\n\njointStockCompany.initialNumberOfShares = 100\n\npricingBehaviour.defaultPriceChangeIncrementExplicit = 0.05\npricingBehaviour.defaultPriceChangeIncrementImplicit = 0.001\n# stability: number of prices should be > 5 \npricingBehaviour.defaultNumberOfPrices = 7\npricingBehaviour.defaultInitialPrice = 5.0\n\ntimeSystem.initializationPhaseInDays = 180\n\ndashboard.log.numberOfAgentsLogSize = 500\n\n# significantly determines stability of prices! numberOfIterations = 20 leads to strong volatility in credit utilization rate -> volatile M1 -> volatile prices\nmath.numberOfIterations = 100\nmath.initializationValue = 0.0000001",
		},
		nodependencies: {
			title: "No dependencies",
			properties: "# -Dconfiguration.properties=nodependencies.configuration.properties\n\nhousehold.EURO.number = 2000\nhousehold.USDOLLAR.number = 2000\nhousehold.YEN.number = 2000\nhousehold.lifespanInDays = 29200\nhousehold.retirementAgeInDays = 23725\n# retirementSaving=true in combination with key interest rate > 0 can cause ad-hoc inflation due to interest on saving deposits\nhousehold.retirementSaving = false\nhousehold.numberOfLabourHoursPerDay = 16\nhousehold.newHouseholdFromAgeInDays = 6570\nhousehold.newHouseholdEveryXDays = 1825\nhousehold.requiredUtilityPerDay = 1.0\nhousehold.daysWithoutUtilityUntilDestructor = 60\nhousehold.maxPricePerUnitMultiplier = 1.0\n\nfactory.capitalDepreciationRatioPerPeriod = 0.001 \n# significantly determining stability of prices; too much money capital -> volatile markets \nfactory.referenceCredit = 10000\nfactory.margin = 0.1\n\nfactory.EURO.IRON.number = 10\nfactory.EURO.COAL.number = 10\nfactory.EURO.COTTON.number = 10\nfactory.EURO.WHEAT.number = 10\nfactory.EURO.FOOD.number = 10\nfactory.EURO.CLOTHING.number = 10\nfactory.EURO.KILOWATT.number = 10\nfactory.EURO.REALESTATE.number = 10\nfactory.EURO.MACHINE.number = 0\n\nfactory.USDOLLAR.IRON.number = 10\nfactory.USDOLLAR.COAL.number = 10\nfactory.USDOLLAR.COTTON.number = 10\nfactory.USDOLLAR.WHEAT.number = 10\nfactory.USDOLLAR.FOOD.number = 10\nfactory.USDOLLAR.CLOTHING.number = 10\nfactory.USDOLLAR.KILOWATT.number = 10\nfactory.USDOLLAR.REALESTATE.number = 10\nfactory.USDOLLAR.MACHINE.number = 0\n\nfactory.YEN.IRON.number = 10\nfactory.YEN.COAL.number = 10\nfactory.YEN.COTTON.number = 10\nfactory.YEN.WHEAT.number = 10\nfactory.YEN.FOOD.number = 10\nfactory.YEN.CLOTHING.number = 10\nfactory.YEN.KILOWATT.number = 10\nfactory.YEN.REALESTATE.number = 10\nfactory.YEN.MACHINE.number = 0\n\ncentralBank.reserveRatio = 0.1\ncentralBank.inflationTarget = 0.02\ncentralBank.targetPriceIndex = 15\n# negative key interest rates can cause abnormal behaviour, e. g. a flow of interest from pension saving bank accounts into the monetary system \n# (which is a problem, as i. e. hoarded money that has been neutralized by credit banks buying state bonds and \n# states buying goods, thereby reintroducing the hoarded money into the monetary system -> expanding M1 -> instable prices)\ncentralBank.minEffectiveKeyInterestRate = 0.0\ncentralBank.maxEffectiveKeyInterestRate = 0.05\ncentralBank.defaultEffectiveKeyInterestRate = 0.02\ncentralBank.statisticalOffice.priceIndexWeights.IRON = 0.125\ncentralBank.statisticalOffice.priceIndexWeights.COAL = 0.125\ncentralBank.statisticalOffice.priceIndexWeights.COTTON = 0.125\ncentralBank.statisticalOffice.priceIndexWeights.WHEAT = 0.125\ncentralBank.statisticalOffice.priceIndexWeights.FOOD = 0.125\ncentralBank.statisticalOffice.priceIndexWeights.CLOTHING = 0.125\ncentralBank.statisticalOffice.priceIndexWeights.KILOWATT = 0.125\ncentralBank.statisticalOffice.priceIndexWeights.REALESTATE = 0.125\n\ncentralBank.EURO.number = 1\ncentralBank.USDOLLAR.number = 1\ncentralBank.YEN.number = 1\n\ncreditBank.EURO.number = 5\ncreditBank.USDOLLAR.number = 5\ncreditBank.YEN.number = 5\ncreditBank.priceChangeIncrement = 0.1\ncreditBank.maxCreditForCurrencyTrading = 100000\ncreditBank.minArbitrageMargin = 0.03\n\ntrader.EURO.number = 10\ntrader.USDOLLAR.number = 10\ntrader.YEN.number = 10\ntrader.arbitrageMargin = 0.2\ntrader.referenceCredit = 10000\n\nstate.EURO.number = 1\nstate.USDOLLAR.number = 1\nstate.YEN.number = 1\nstate.bondMargin = 0.02\n\nagent.balanceSheetPublicationHourType = HOUR_23\n\nbudgetingBehaviour.internalRateOfReturn = 0.05\nbudgetingBehaviour.keyInterestRateTransmissionDamper = 1000\n\ninputOutputModel = InputOutputModelNoDependencies\n\njointStockCompany.initialNumberOfShares = 100\n\npricingBehaviour.defaultPriceChangeIncrementExplicit = 0.05\npricingBehaviour.defaultPriceChangeIncrementImplicit = 0.001\n# stability: number of prices should be > 5 \npricingBehaviour.defaultNumberOfPrices = 7\npricingBehaviour.defaultInitialPrice = 5.0\n\ntimeSystem.initializationPhaseInDays = 180\n\ndashboard.log.numberOfAgentsLogSize = 500\n\n# significantly determines stability of prices! numberOfIterations = 20 leads to strong volatility in credit utilization rate -> volatile M1 -> volatile prices\nmath.numberOfIterations = 100\nmath.initializationValue = 0.0000001",
		},
		minimal: {
			title: "Minimal (one currency)",
			properties: "# -Dconfiguration.properties=minimal.configuration.properties\n\nhousehold.EURO.number = 1000\nhousehold.USDOLLAR.number = 0\nhousehold.YEN.number = 0\nhousehold.lifespanInDays = 999999\nhousehold.retirementAgeInDays = 999999\nhousehold.retirementSaving = false\nhousehold.numberOfLabourHoursPerDay = 16\nhousehold.newHouseholdFromAgeInDays = 999999\nhousehold.newHouseholdEveryXDays = 999999\nhousehold.requiredUtilityPerDay = 0.0\nhousehold.daysWithoutUtilityUntilDestructor = 999999\nhousehold.maxPricePerUnitMultiplier = 1.0\n\nfactory.capitalDepreciationRatioPerPeriod = 0.0\n# significantly determining stability of prices; too much money capital -> volatile markets \nfactory.referenceCredit = 10000\nfactory.margin = 0.05\n\nfactory.EURO.IRON.number = 0\nfactory.EURO.COAL.number = 4\nfactory.EURO.COTTON.number = 0\nfactory.EURO.WHEAT.number = 4\nfactory.EURO.FOOD.number = 0\nfactory.EURO.CLOTHING.number = 0\nfactory.EURO.KILOWATT.number = 0\nfactory.EURO.REALESTATE.number = 0\nfactory.EURO.MACHINE.number = 0\n\nfactory.USDOLLAR.IRON.number = 0\nfactory.USDOLLAR.COAL.number = 0\nfactory.USDOLLAR.COTTON.number = 0\nfactory.USDOLLAR.WHEAT.number = 0\nfactory.USDOLLAR.FOOD.number = 0\nfactory.USDOLLAR.CLOTHING.number = 0\nfactory.USDOLLAR.KILOWATT.number = 0\nfactory.USDOLLAR.REALESTATE.number = 0\nfactory.USDOLLAR.MACHINE.number = 0\n\nfactory.YEN.IRON.number = 0\nfactory.YEN.COAL.number = 0\nfactory.YEN.COTTON.number = 0\nfactory.YEN.WHEAT.number = 0\nfactory.YEN.FOOD.number = 0\nfactory.YEN.CLOTHING.number = 0\nfactory.YEN.KILOWATT.number = 0\nfactory.YEN.REALESTATE.number = 0\nfactory.YEN.MACHINE.number = 0\n\ncentralBank.reserveRatio = 0.1\ncentralBank.inflationTarget = 0.02\ncentralBank.targetPriceIndex = 10.0\n# negative key interest rates can cause abnormal behaviour, e. g. a flow of interest from pension saving bank accounts into the monetary system \n# (which is a problem, as i. e. hoarded money that has been neutralized by credit banks buying state bonds and \n# states buying goods, thereby reintroducing the hoarded money into the monetary system -> expanding M1 -> instable prices)\ncentralBank.minEffectiveKeyInterestRate = 0.0\ncentralBank.maxEffectiveKeyInterestRate = 0.05\ncentralBank.defaultEffectiveKeyInterestRate = 0.02\ncentralBank.statisticalOffice.priceIndexWeights.WHEAT = 0.5\ncentralBank.statisticalOffice.priceIndexWeights.COAL = 0.5\n\ncentralBank.EURO.number = 1\ncentralBank.USDOLLAR.number = 0\ncentralBank.YEN.number = 0\n\ncreditBank.EURO.number = 5\ncreditBank.USDOLLAR.number = 0\ncreditBank.YEN.number = 0\ncreditBank.priceChangeIncrement = 0.1\ncreditBank.maxCreditForCurrencyTrading = 100000\ncreditBank.minArbitrageMargin = 0.03\n\ntrader.EURO.number = 0\ntrader.USDOLLAR.number = 0\ntrader.YEN.number = 0\ntrader.arbitrageMargin = 0.2\ntrader.referenceCredit = 10000\n\nstate.EURO.number = 1\nstate.USDOLLAR.number = 0\nstate.YEN.number = 0\nstate.bondMargin = 0.02\n\nagent.balanceSheetPublicationHourType = HOUR_23\n\nbudgetingBehaviour.internalRateOfReturn = 0.03\nbudgetingBehaviour.keyInterestRateTransmissionDamper = 1000\n\ninputOutputModel = InputOutputModelMinimal\n\njointStockCompany.initialNumberOfShares = 100\n\npricingBehaviour.defaultPriceChangeIncrementExplicit = 0.05\npricingBehaviour.defaultPriceChangeIncrementImplicit = 0.001\n# stability: number of prices should be > 5 \npricingBehaviour.defaultNumberOfPrices = 9\npricingBehaviour.defaultInitialPrice = 7.5\n\ntimeSystem.initializationPhaseInDays = 180\n\ndashboard.log.numberOfAgentsLogSize = 500\n\n# significantly determines stability of prices! numberOfIterations = 20 leads to strong volatility in credit utilization rate -> volatile M1 -> volatile prices\nmath.numberOfIterations = 200\nmath.initializationValue = 0.0000001",
		},
	};

	function parseProperties(text) {
		const properties = {};
		for (const rawLine of text.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) {
				continue;
			}
			const separator = line.search(/[=:]/);
			if (separator === -1) {
				continue;
			}
			properties[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
		}
		return properties;
	}

	class Configuration {
		/**
		 * @param presetName  key of PRESETS
		 * @param overrides   optional map of property keys to values
		 * @param agentScale  factor applied to the number of households, factories,
		 *                    credit banks and traders
		 */
		constructor(presetName, overrides, agentScale) {
			const preset = PRESETS[presetName];
			if (!preset) {
				throw new Error("unknown configuration preset " + presetName);
			}
			this.presetName = presetName;
			this.properties = Object.assign(parseProperties(preset.properties), overrides || {});
			this.agentScale = agentScale === undefined ? 1.0 : agentScale;

			const { GoodType, Currency } = CE;
			const number = (key) => {
				const value = this.properties[key];
				if (value === undefined) {
					throw new Error("missing configuration property " + key);
				}
				return parseFloat(value);
			};
			const optionalNumber = (key, defaultValue) =>
				this.properties[key] === undefined ? defaultValue : parseFloat(this.properties[key]);
			const scaled = (key) => {
				const value = optionalNumber(key, 0);
				return value > 0 ? Math.max(1, Math.round(value * this.agentScale)) : 0;
			};
			const perCurrency = (prefix, scale) => {
				const result = {};
				for (const currency of Currency.values()) {
					const key = prefix + "." + currency.name + ".number";
					result[currency.name] = scale ? scaled(key) : optionalNumber(key, 0);
				}
				return result;
			};

			this.agentConfig = {
				balanceSheetPublicationHourType: parseInt(
						this.properties["agent.balanceSheetPublicationHourType"].replace("HOUR_", ""), 10),
			};
			this.budgetingBehaviourConfig = {
				internalRateOfReturn: number("budgetingBehaviour.internalRateOfReturn"),
				keyInterestRateTransmissionDamper: number("budgetingBehaviour.keyInterestRateTransmissionDamper"),
			};
			const priceIndexWeights = {};
			for (const goodType of GoodType.values()) {
				priceIndexWeights[goodType.name] = optionalNumber(
						"centralBank.statisticalOffice.priceIndexWeights." + goodType.name, 0.0);
			}
			this.centralBankConfig = {
				defaultEffectiveKeyInterestRate: number("centralBank.defaultEffectiveKeyInterestRate"),
				inflationTarget: number("centralBank.inflationTarget"),
				maxEffectiveKeyInterestRate: number("centralBank.maxEffectiveKeyInterestRate"),
				minEffectiveKeyInterestRate: number("centralBank.minEffectiveKeyInterestRate"),
				reserveRatio: number("centralBank.reserveRatio"),
				targetPriceIndex: number("centralBank.targetPriceIndex"),
				number: perCurrency("centralBank", false),
				statisticalOfficeConfig: { priceIndexWeights },
			};
			this.creditBankConfig = {
				maxCreditForCurrencyTrading: number("creditBank.maxCreditForCurrencyTrading"),
				minArbitrageMargin: number("creditBank.minArbitrageMargin"),
				priceChangeIncrement: number("creditBank.priceChangeIncrement"),
				number: perCurrency("creditBank", true),
			};
			const factoryNumbers = {};
			for (const currency of Currency.values()) {
				factoryNumbers[currency.name] = {};
				for (const goodType of GoodType.values()) {
					factoryNumbers[currency.name][goodType.name] = scaled(
							"factory." + currency.name + "." + goodType.name + ".number");
				}
			}
			this.factoryConfig = {
				capitalDepreciationRatioPerPeriod: number("factory.capitalDepreciationRatioPerPeriod"),
				margin: number("factory.margin"),
				referenceCredit: number("factory.referenceCredit"),
				number: factoryNumbers,
			};
			this.householdConfig = {
				daysWithoutUtilityUntilDestructor: number("household.daysWithoutUtilityUntilDestructor"),
				lifespanInDays: number("household.lifespanInDays"),
				maxPricePerUnitMultiplier: number("household.maxPricePerUnitMultiplier"),
				newHouseholdEveryXDays: number("household.newHouseholdEveryXDays"),
				newHouseholdFromAgeInDays: number("household.newHouseholdFromAgeInDays"),
				numberOfLabourHoursPerDay: number("household.numberOfLabourHoursPerDay"),
				requiredUtilityPerDay: number("household.requiredUtilityPerDay"),
				retirementAgeInDays: number("household.retirementAgeInDays"),
				retirementSaving: this.properties["household.retirementSaving"] === "true",
				number: perCurrency("household", true),
			};
			this.inputOutputModelConfig = { inputOutputModel: this.properties["inputOutputModel"] };
			this.jointStockCompanyConfig = {
				initialNumberOfShares: number("jointStockCompany.initialNumberOfShares"),
			};
			this.mathConfig = {
				initializationValue: number("math.initializationValue"),
				numberOfIterations: number("math.numberOfIterations"),
			};
			this.pricingBehaviourConfig = {
				defaultInitialPrice: number("pricingBehaviour.defaultInitialPrice"),
				defaultNumberOfPrices: number("pricingBehaviour.defaultNumberOfPrices"),
				defaultPriceChangeIncrementExplicit: number("pricingBehaviour.defaultPriceChangeIncrementExplicit"),
				defaultPriceChangeIncrementImplicit: number("pricingBehaviour.defaultPriceChangeIncrementImplicit"),
			};
			this.stateConfig = {
				bondMargin: number("state.bondMargin"),
				number: perCurrency("state", false),
			};
			this.timeSystemConfig = {
				initializationPhaseInDays: number("timeSystem.initializationPhaseInDays"),
			};
			this.traderConfig = {
				arbitrageMargin: number("trader.arbitrageMargin"),
				referenceCredit: number("trader.referenceCredit"),
				number: perCurrency("trader", true),
			};
		}
	}

	CE.Configuration = Configuration;
	CE.CONFIGURATION_PRESETS = PRESETS;
	CE.parseProperties = parseProperties;
})(typeof self !== "undefined" ? self : globalThis);
