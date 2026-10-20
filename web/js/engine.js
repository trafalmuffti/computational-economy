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
 * JavaScript port of the simulation engine and the economy of the Java
 * packages io.github.uwol.compecon.engine.* and io.github.uwol.compecon.economy.*.
 * The class structure follows the Java implementation; the in-memory DAOs and
 * factories are collapsed into the Simulation context. Numerical optimizations
 * are delegated to the asm.js kernels (kernels.js).
 */
(function (root) {
	"use strict";

	const CE = (root.CompEcon = root.CompEcon || {});
	const { GoodType, Currency, MoneyType, TermType, MathUtil, JavaRandom, SortedOrderBook, IndexedList } = CE;
	const { ConvexFunction, FunctionKind } = CE.Kernels;

	const EVERY = -1;
	const EMPTY_SET = new Set();
	const LABOURHOUR = GoodType.LABOURHOUR;

	/*
	 * time system
	 */

	class TimeSystemEvent {
		constructor(owner, onEvent) {
			this.owner = owner;
			this.onEvent = onEvent;
		}

		isDeconstructed() {
			return this.owner.isDeconstructed;
		}
	}

	/**
	 * Port of TimeSystemImpl: events are registered for year / month / day / hour,
	 * where -1 denotes EVERY. Months are numbered 0..11, days 1..31, hours 0..23.
	 */
	class TimeSystem {
		constructor(simulation, startYear) {
			this.simulation = simulation;
			this.startYear = startYear;
			this.time = Date.UTC(startYear, 0, 1, 0);
			this.date = new Date(this.time);
			this.dayNumber = 0;
			this.years = new Map();
			this.externalEvents = [];
			this.eventErrors = 0;
		}

		addEvent(event, year, month, day, hour) {
			let months = this.years.get(year);
			if (!months) {
				months = new Map();
				this.years.set(year, months);
			}
			let days = months.get(month);
			if (!days) {
				days = new Map();
				months.set(month, days);
			}
			let hours = days.get(day);
			if (!hours) {
				hours = new Map();
				days.set(day, hours);
			}
			let events = hours.get(hour);
			if (!events) {
				events = new Set();
				hours.set(hour, events);
			}
			events.add(event);
		}

		/**
		 * registers the event for every hour except the given one
		 */
		addEventEvery(event, year, month, day, exceptHour) {
			for (let hour = 0; hour < 24; hour++) {
				if (hour !== exceptHour) {
					this.addEvent(event, year, month, day, hour);
				}
			}
		}

		addExternalEvent(event) {
			this.externalEvents.push(event);
		}

		getCurrentYear() {
			return this.date.getUTCFullYear();
		}

		getCurrentMonthType() {
			return this.date.getUTCMonth();
		}

		getCurrentMonthNumberInYear() {
			return this.date.getUTCMonth() + 1;
		}

		getCurrentDayNumberInMonth() {
			return this.date.getUTCDate();
		}

		getCurrentDayType() {
			return this.date.getUTCDate();
		}

		getCurrentHourType() {
			return this.date.getUTCHours();
		}

		getCurrentDate() {
			return this.date;
		}

		isInitializationPhase() {
			return this.dayNumber < this.simulation.configuration.timeSystemConfig.initializationPhaseInDays;
		}

		nextHour() {
			this.time += 3600000;
			this.date = new Date(this.time);
			this.simulation.log.notifyTimeSystem_nextHour(this.date);
			if (this.getCurrentHourType() === 0) {
				this.simulation.log.notifyTimeSystem_nextDay(this.date);
				this.dayNumber++;
			}
			this.triggerEvents();
		}

		removeEvents(events) {
			if (!events || events.size === 0) {
				return;
			}
			for (const months of this.years.values()) {
				for (const days of months.values()) {
					for (const hours of days.values()) {
						for (const hourEvents of hours.values()) {
							for (const event of events) {
								hourEvents.delete(event);
							}
						}
					}
				}
			}
		}

		suggestRandomHourType(minHour = 1, maxHour = 22) {
			const limit = maxHour + 1 - minHour;
			return minHour + this.simulation.random.nextInt(limit);
		}

		collectEvents(year, month, day, hour) {
			const result = new Set();
			for (const y of [year, EVERY]) {
				const months = this.years.get(y);
				if (!months) {
					continue;
				}
				for (const m of [month, EVERY]) {
					const days = months.get(m);
					if (!days) {
						continue;
					}
					for (const d of [day, EVERY]) {
						const hours = days.get(d);
						if (!hours) {
							continue;
						}
						for (const h of [hour, EVERY]) {
							const events = hours.get(h);
							if (events) {
								for (const event of events) {
									result.add(event);
								}
							}
						}
					}
				}
			}
			return result;
		}

		triggerEvents() {
			const hour = this.getCurrentHourType();
			const events = Array.from(this.collectEvents(this.getCurrentYear(), this.getCurrentMonthType(),
					this.getCurrentDayType(), hour));
			/*
			 * important: every time this method is called, events have to be shuffled, so
			 * that each day gives each agent a new chance of being first
			 */
			this.simulation.random.shuffle(events);
			for (const event of events) {
				/*
				 * it may happen, that an event deconstructs an agent, and that agent has
				 * registered other events for the same point in time -> check for
				 * deconstruction
				 */
				if (!event.isDeconstructed()) {
					this.runEvent(event);
				}
			}
			if (hour === 0) {
				for (const event of this.externalEvents) {
					this.runEvent(event);
				}
				this.externalEvents = [];
			}
		}

		runEvent(event) {
			try {
				event.onEvent();
			} catch (e) {
				this.eventErrors++;
				if (this.eventErrors <= 10) {
					console.error(e);
				}
			}
		}
	}

	/*
	 * input-output models
	 */

	function cesFunction(mainCoefficient, coefficients, substitutionFactor, homogenityFactor) {
		const inputTypes = coefficients.map((entry) => GoodType[entry[0]]);
		return new ConvexFunction(FunctionKind.CES, inputTypes, coefficients.map((entry) => entry[1]),
				mainCoefficient, substitutionFactor, homogenityFactor);
	}

	function cobbDouglasFunction(coefficient, exponents) {
		const inputTypes = exponents.map((entry) => GoodType[entry[0]]);
		return new ConvexFunction(FunctionKind.COBB_DOUGLAS, inputTypes, exponents.map((entry) => entry[1]),
				coefficient);
	}

	function rootFunction(inputType, coefficient) {
		return new ConvexFunction(FunctionKind.ROOT, [GoodType[inputType]], [1.0], coefficient);
	}

	const CES_PRIMARY = [["LABOURHOUR", 0.6], ["MACHINE", 0.2]];

	const INPUT_OUTPUT_MODELS = {
		InputOutputModelInterdependencies: {
			getProductionFunction(outputGoodType) {
				switch (outputGoodType.name) {
				case "MACHINE":
					return rootFunction("LABOURHOUR", 5.0);
				case "IRON":
				case "COAL":
				case "COTTON":
				case "WHEAT":
					return cesFunction(50.0, CES_PRIMARY, -0.7, 0.65);
				case "FOOD":
					return cesFunction(1.0, [["WHEAT", 0.6], ["LABOURHOUR", 0.1]], -0.8, 0.7);
				case "KILOWATT":
					return cesFunction(1.0, [["LABOURHOUR", 0.2], ["COAL", 0.4]], -0.8, 0.7);
				case "CLOTHING":
					return cesFunction(1.0, [["COTTON", 0.5], ["COAL", 0.2]], -0.8, 0.7);
				case "REALESTATE":
					return cesFunction(1.0, [["IRON", 0.3], ["LABOURHOUR", 0.3]], -0.8, 0.7);
				default:
					return null;
				}
			},
			getUtilityFunctionOfHousehold() {
				return cesFunction(1.0, [["IRON", 0.2], ["COAL", 0.2], ["COTTON", 0.2], ["WHEAT", 0.2], ["FOOD", 0.2],
					["CLOTHING", 0.2], ["REALESTATE", 0.2], ["KILOWATT", 0.2], ["LABOURHOUR", 0.2]], -0.7, 0.5);
			},
		},
		InputOutputModelMinimal: {
			getProductionFunction(outputGoodType) {
				switch (outputGoodType.name) {
				case "COAL":
				case "WHEAT":
					return rootFunction("LABOURHOUR", 5.0);
				default:
					return null;
				}
			},
			getUtilityFunctionOfHousehold() {
				return cobbDouglasFunction(1.0, [["WHEAT", 0.4], ["COAL", 0.4], ["LABOURHOUR", 0.2]]);
			},
		},
		InputOutputModelNoDependencies: {
			getProductionFunction(outputGoodType) {
				switch (outputGoodType.name) {
				case "IRON":
				case "COAL":
				case "COTTON":
				case "WHEAT":
				case "KILOWATT":
				case "CLOTHING":
				case "FOOD":
				case "REALESTATE":
					return rootFunction("LABOURHOUR", 100.0);
				default:
					return null;
				}
			},
			getUtilityFunctionOfHousehold() {
				return INPUT_OUTPUT_MODELS.InputOutputModelInterdependencies.getUtilityFunctionOfHousehold();
			},
		},
		InputOutputModelTesting: {
			getProductionFunction(outputGoodType) {
				switch (outputGoodType.name) {
				case "MACHINE":
					return rootFunction("LABOURHOUR", 5.0);
				case "WHEAT":
				case "COAL":
					return cesFunction(50.0, [["LABOURHOUR", 1.0], ["MACHINE", 0.2]], -0.7, 0.65);
				default:
					return null;
				}
			},
			getUtilityFunctionOfHousehold() {
				return cesFunction(1.0, [["WHEAT", 0.3], ["COAL", 0.3], ["LABOURHOUR", 0.3]], -0.7, 0.5);
			},
		},
	};

	/*
	 * markets
	 */

	const CommodityType = { CURRENCY: "CURRENCY", GOODTYPE: "GOODTYPE", PROPERTY: "PROPERTY" };

	class MarketOrder {
		constructor(id) {
			this.id = id;
			this.amount = 0;
			this.commodityCurrency = null;
			this.commodityCurrencyOfferorsBankAccountDelegate = null;
			this.currency = null;
			this.goodType = null;
			this.offeror = null;
			this.offerorsBankAccountDelegate = null;
			this.pricePerUnit = 0;
			this.property = null;
		}

		getCommodityType() {
			if (this.commodityCurrency !== null) {
				return CommodityType.CURRENCY;
			}
			if (this.property !== null) {
				return CommodityType.PROPERTY;
			}
			return CommodityType.GOODTYPE;
		}
	}

	/**
	 * Port of MarketOrderDAOImpl: one sorted order book per currency and good
	 * type, commodity currency and property class.
	 */
	class MarketOrderDAO {
		constructor() {
			const currencies = Currency.values();
			this.goodTypeBooks = currencies.map(() => GoodType.values().map(() => new SortedOrderBook()));
			this.currencyBooks = currencies.map(() => currencies.map(() => new SortedOrderBook()));
			this.propertyBooks = currencies.map(() => ({ Share: new SortedOrderBook(), FixedRateBond: new SortedOrderBook() }));
			this.ordersByOfferor = new Map();
		}

		getBookForGoodType(currency, goodType) {
			return this.goodTypeBooks[currency.ordinal][goodType.ordinal];
		}

		getBookForCurrency(currency, commodityCurrency) {
			return this.currencyBooks[currency.ordinal][commodityCurrency.ordinal];
		}

		getBookForPropertyClass(currency, propertyClassName) {
			return this.propertyBooks[currency.ordinal][propertyClassName];
		}

		getBook(marketOrder) {
			if (marketOrder.goodType !== null) {
				return this.getBookForGoodType(marketOrder.currency, marketOrder.goodType);
			}
			if (marketOrder.commodityCurrency !== null) {
				return this.getBookForCurrency(marketOrder.currency, marketOrder.commodityCurrency);
			}
			return this.getBookForPropertyClass(marketOrder.currency, marketOrder.property.propertyClassName);
		}

		save(marketOrder) {
			this.getBook(marketOrder).add(marketOrder);
			let orders = this.ordersByOfferor.get(marketOrder.offeror);
			if (!orders) {
				orders = new Set();
				this.ordersByOfferor.set(marketOrder.offeror, orders);
			}
			orders.add(marketOrder);
		}

		delete(marketOrder) {
			this.getBook(marketOrder).remove(marketOrder);
			const orders = this.ordersByOfferor.get(marketOrder.offeror);
			if (orders) {
				orders.delete(marketOrder);
				if (orders.size === 0) {
					this.ordersByOfferor.delete(marketOrder.offeror);
				}
			}
		}

		deleteAllSellingOrders(offeror) {
			const orders = this.ordersByOfferor.get(offeror);
			if (orders) {
				for (const marketOrder of Array.from(orders)) {
					this.delete(marketOrder);
				}
			}
		}

		deleteAllSellingOrdersForGoodType(offeror, currency, goodType) {
			const orders = this.ordersByOfferor.get(offeror);
			if (orders) {
				for (const marketOrder of Array.from(orders)) {
					if (marketOrder.currency === currency && marketOrder.goodType === goodType) {
						this.delete(marketOrder);
					}
				}
			}
		}

		deleteAllSellingOrdersForCurrency(offeror, currency, commodityCurrency) {
			const orders = this.ordersByOfferor.get(offeror);
			if (orders) {
				for (const marketOrder of Array.from(orders)) {
					if (marketOrder.currency === currency && marketOrder.commodityCurrency === commodityCurrency) {
						this.delete(marketOrder);
					}
				}
			}
		}
	}

	/**
	 * Port of SettlementMarketServiceImpl / MarketServiceImpl
	 */
	class MarketService {
		constructor(simulation) {
			this.simulation = simulation;
			this.dao = new MarketOrderDAO();
		}

		/*
		 * marginal market prices
		 */

		getMarginalMarketPrice(denominatedInCurrency, goodType) {
			const first = this.dao.getBookForGoodType(denominatedInCurrency, goodType).first();
			return first === undefined ? NaN : first.pricePerUnit;
		}

		getMarginalMarketPriceOfCurrency(denominatedInCurrency, commodityCurrency) {
			const first = this.dao.getBookForCurrency(denominatedInCurrency, commodityCurrency).first();
			return first === undefined ? NaN : first.pricePerUnit;
		}

		getMarginalMarketPriceOfPropertyClass(denominatedInCurrency, propertyClassName) {
			const first = this.dao.getBookForPropertyClass(denominatedInCurrency, propertyClassName).first();
			return first === undefined ? NaN : first.pricePerUnit;
		}

		getMarginalMarketPrices(denominatedInCurrency) {
			return GoodType.values().map((goodType) => this.getMarginalMarketPrice(denominatedInCurrency, goodType));
		}

		getMarketDepth(denominatedInCurrency, goodType) {
			let amount = 0.0;
			for (const marketOrder of this.dao.getBookForGoodType(denominatedInCurrency, goodType)) {
				amount += marketOrder.amount;
			}
			return amount;
		}

		/*
		 * price functions
		 */

		getFixedPriceFunctions(denominatedInCurrency, goodTypes) {
			return goodTypes.map((goodType) => ({ fixedPrice: this.getMarginalMarketPrice(denominatedInCurrency, goodType) }));
		}

		getMarketPriceFunctions(denominatedInCurrency, goodTypes) {
			return goodTypes.map((goodType) => ({ orderBook: this.dao.getBookForGoodType(denominatedInCurrency, goodType) }));
		}

		/*
		 * place selling orders
		 */

		placeSellingOfferForGoodType(goodType, offeror, offerorsBankAccountDelegate, amount, pricePerUnit) {
			if (amount > 0) {
				const marketOrder = new MarketOrder(this.simulation.nextId());
				marketOrder.currency = offerorsBankAccountDelegate.getBankAccount().currency;
				marketOrder.goodType = goodType;
				marketOrder.offeror = offeror;
				marketOrder.offerorsBankAccountDelegate = offerorsBankAccountDelegate;
				marketOrder.amount = amount;
				marketOrder.pricePerUnit = pricePerUnit;
				this.dao.save(marketOrder);
			}
		}

		placeSellingOfferForCurrency(commodityCurrency, offeror, offerorsBankAccountDelegate, amount, pricePerUnit,
				commodityCurrencyOfferorsBankAccountDelegate) {
			if (amount > 0) {
				const marketOrder = new MarketOrder(this.simulation.nextId());
				marketOrder.currency = offerorsBankAccountDelegate.getBankAccount().currency;
				marketOrder.commodityCurrency = commodityCurrency;
				marketOrder.offeror = offeror;
				marketOrder.offerorsBankAccountDelegate = offerorsBankAccountDelegate;
				marketOrder.amount = amount;
				marketOrder.pricePerUnit = pricePerUnit;
				marketOrder.commodityCurrencyOfferorsBankAccountDelegate = commodityCurrencyOfferorsBankAccountDelegate;
				this.dao.save(marketOrder);
			}
		}

		placeSellingOfferForProperty(property, offeror, offerorsBankAccountDelegate, pricePerUnit) {
			const marketOrder = new MarketOrder(this.simulation.nextId());
			marketOrder.currency = offerorsBankAccountDelegate.getBankAccount().currency;
			marketOrder.property = property;
			marketOrder.offeror = offeror;
			marketOrder.offerorsBankAccountDelegate = offerorsBankAccountDelegate;
			marketOrder.amount = 1;
			marketOrder.pricePerUnit = pricePerUnit;
			this.dao.save(marketOrder);
		}

		/*
		 * remove selling orders
		 */

		removeAllSellingOffers(offeror) {
			this.dao.deleteAllSellingOrders(offeror);
		}

		removeAllSellingOffersForGoodType(offeror, denominatedInCurrency, goodType) {
			this.dao.deleteAllSellingOrdersForGoodType(offeror, denominatedInCurrency, goodType);
		}

		removeAllSellingOffersForCurrency(offeror, denominatedInCurrency, commodityCurrency) {
			this.dao.deleteAllSellingOrdersForCurrency(offeror, denominatedInCurrency, commodityCurrency);
		}

		/*
		 * fulfillment
		 */

		findBestFulfillmentSet(orderBook, maxAmount, maxTotalPrice, maxPricePerUnit, wholeNumber) {
			const selectedOffers = [];
			const restrictMaxAmount = Number.isFinite(maxAmount);
			const restrictTotalPrice = Number.isFinite(maxTotalPrice);
			const restrictMaxPricePerUnit = Number.isFinite(maxPricePerUnit);
			let selectedAmount = 0;
			let spentMoney = 0;
			/*
			 * search for orders starting with the lowest price/unit
			 */
			orderBook.forEachUntil((marketOrder) => {
				if (restrictMaxPricePerUnit && MathUtil.greater(marketOrder.pricePerUnit, maxPricePerUnit)) {
					return false;
				}
				let amountToTakeByMaxAmountRestriction;
				let amountToTakeByTotalPriceRestriction;
				let amountToTakeByMaxPricePerUnitRestriction;
				if (restrictMaxAmount) {
					amountToTakeByMaxAmountRestriction = Math.min(maxAmount - selectedAmount, marketOrder.amount);
				} else {
					amountToTakeByMaxAmountRestriction = marketOrder.amount;
				}
				if (restrictTotalPrice && marketOrder.pricePerUnit !== 0) {
					amountToTakeByTotalPriceRestriction = Math.min((maxTotalPrice - spentMoney) / marketOrder.pricePerUnit,
							marketOrder.amount);
				} else {
					amountToTakeByTotalPriceRestriction = marketOrder.amount;
				}
				if (restrictMaxPricePerUnit && marketOrder.pricePerUnit > maxPricePerUnit) {
					amountToTakeByMaxPricePerUnitRestriction = 0;
				} else {
					amountToTakeByMaxPricePerUnitRestriction = marketOrder.amount;
				}
				let amountToTake = Math.max(0, Math.min(amountToTakeByMaxAmountRestriction,
						Math.min(amountToTakeByTotalPriceRestriction, amountToTakeByMaxPricePerUnitRestriction)));
				if (wholeNumber) {
					amountToTake = Math.trunc(amountToTake);
				}
				const totalPrice = amountToTake * marketOrder.pricePerUnit;
				if (amountToTake === 0) {
					return false;
				}
				selectedOffers.push([marketOrder, amountToTake]);
				selectedAmount += amountToTake;
				spentMoney += totalPrice;
				return true;
			});
			return selectedOffers;
		}

		buyGoodType(goodType, maxAmount, maxTotalPrice, maxPricePerUnit, buyer, buyersBankAccountDelegate) {
			const orderBook = this.dao.getBookForGoodType(buyersBankAccountDelegate.getBankAccount().currency, goodType);
			return this.buy(orderBook, maxAmount, maxTotalPrice, maxPricePerUnit, goodType.wholeNumber, buyer,
					buyersBankAccountDelegate, null);
		}

		buyCurrency(commodityCurrency, maxAmount, maxTotalPrice, maxPricePerUnit, buyer, buyersBankAccountDelegate,
				buyersBankAccountForCommodityCurrencyDelegate) {
			const orderBook = this.dao.getBookForCurrency(buyersBankAccountDelegate.getBankAccount().currency,
					commodityCurrency);
			return this.buy(orderBook, maxAmount, maxTotalPrice, maxPricePerUnit, false, buyer,
					buyersBankAccountDelegate, buyersBankAccountForCommodityCurrencyDelegate);
		}

		buyProperty(propertyClassName, maxAmount, maxTotalPrice, maxPricePerUnit, buyer, buyersBankAccountDelegate) {
			const orderBook = this.dao.getBookForPropertyClass(buyersBankAccountDelegate.getBankAccount().currency,
					propertyClassName);
			return this.buy(orderBook, maxAmount, maxTotalPrice, maxPricePerUnit, true, buyer,
					buyersBankAccountDelegate, null);
		}

		buy(orderBook, maxAmount, maxTotalPrice, maxPricePerUnit, wholeNumber, buyer, buyersBankAccountDelegate,
				buyersBankAccountForCommodityCurrencyDelegate) {
			const simulation = this.simulation;
			const marketOffers = this.findBestFulfillmentSet(orderBook, maxAmount, maxTotalPrice, maxPricePerUnit,
					wholeNumber);
			const buyersBankAccount = buyersBankAccountDelegate.getBankAccount();
			const buyersBank = buyersBankAccount.managingBank;
			let moneySpentSum = 0;
			let amountSum = 0;
			for (const [marketOrder, amount] of marketOffers) {
				const offerorsBankAccount = marketOrder.offerorsBankAccountDelegate.getBankAccount();
				// no self-trading
				if (buyersBankAccount === offerorsBankAccount) {
					continue;
				}
				if (buyersBankAccount.owner === offerorsBankAccount.owner) {
					continue;
				}
				buyersBank.transferMoney(buyersBankAccount, offerorsBankAccount, amount * marketOrder.pricePerUnit,
						"price for units");
				switch (marketOrder.getCommodityType()) {
				case CommodityType.GOODTYPE:
					simulation.propertyService.transferGoodTypeAmount(marketOrder.goodType, marketOrder.offeror, buyer,
							amount);
					marketOrder.amount -= amount;
					marketOrder.offeror.onMarketSettlementOfGoodType(marketOrder.goodType, amount,
							marketOrder.pricePerUnit, offerorsBankAccount.currency);
					simulation.log.market_onTickGoodType(marketOrder.pricePerUnit, marketOrder.goodType,
							offerorsBankAccount.currency, amount);
					if (MathUtil.lesserEqual(marketOrder.amount, 0)) {
						this.dao.delete(marketOrder);
					}
					break;
				case CommodityType.CURRENCY: {
					const commodityBankAccount = marketOrder.commodityCurrencyOfferorsBankAccountDelegate.getBankAccount();
					commodityBankAccount.managingBank.transferMoney(commodityBankAccount,
							buyersBankAccountForCommodityCurrencyDelegate.getBankAccount(), amount,
							"transfer of units of commodity currency");
					marketOrder.amount -= amount;
					marketOrder.offeror.onMarketSettlementOfCurrency(marketOrder.commodityCurrency, amount,
							marketOrder.pricePerUnit, offerorsBankAccount.currency);
					simulation.log.market_onTickCurrency(marketOrder.pricePerUnit, marketOrder.commodityCurrency,
							offerorsBankAccount.currency, amount);
					if (MathUtil.lesserEqual(marketOrder.amount, 0)) {
						this.dao.delete(marketOrder);
					}
					break;
				}
				case CommodityType.PROPERTY:
					simulation.propertyService.transferProperty(marketOrder.property, marketOrder.offeror, buyer);
					marketOrder.offeror.onMarketSettlementOfProperty(marketOrder.property, marketOrder.pricePerUnit,
							offerorsBankAccount.currency);
					this.dao.delete(marketOrder);
					break;
				}
				moneySpentSum += amount * marketOrder.pricePerUnit;
				amountSum += amount;
			}
			return [moneySpentSum, amountSum];
		}
	}

	/*
	 * properties
	 */

	class Property {
		constructor(simulation, id) {
			this.simulation = simulation;
			this.id = id;
			this.isDeconstructed = false;
			this.owner = null;
		}

		deconstruct() {
			this.isDeconstructed = true;
			this.simulation.propertyService.deleteProperty(this);
		}

		resetOwner() {
			this.owner = null;
		}
	}

	class PropertyIssued extends Property {
		constructor(simulation, id) {
			super(simulation, id);
			this.issuer = null;
		}
	}

	class Share extends PropertyIssued {
		constructor(simulation, id) {
			super(simulation, id);
			this.propertyClassName = "Share";
			this.dividendBankAccountDelegate = null;
		}

		resetOwner() {
			super.resetOwner();
			this.dividendBankAccountDelegate = null;
		}
	}

	class FixedRateBond extends PropertyIssued {
		constructor(simulation, id) {
			super(simulation, id);
			this.propertyClassName = "FixedRateBond";
			this.faceValue = 0;
			this.faceValueFromBankAccountDelegate = null;
			this.faceValueToBankAccountDelegate = null;
			this.issuedInCurrency = null;
			this.termInYears = 1;
			this.timeSystemEvents = new Set();
			this.coupon = 0;
			this.couponFromBankAccountDelegate = null;
			this.couponToBankAccountDelegate = null;
		}

		initialize() {
			const timeSystem = this.simulation.timeSystem;
			const transferFaceValueEvent = new TimeSystemEvent(this, () => {
				if (this.faceValueToBankAccountDelegate !== null) {
					const from = this.faceValueFromBankAccountDelegate.getBankAccount();
					from.managingBank.transferMoney(from, this.faceValueToBankAccountDelegate.getBankAccount(),
							this.faceValue, "bond face value");
				}
				// delete bond from simulation
				this.deconstruct();
			});
			this.timeSystemEvents.add(transferFaceValueEvent);
			timeSystem.addEvent(transferFaceValueEvent, timeSystem.getCurrentYear() + this.termInYears,
					timeSystem.getCurrentMonthType(), timeSystem.getCurrentDayType(), 1);

			const transferCouponEvent = new TimeSystemEvent(this, () => {
				if (this.couponToBankAccountDelegate !== null) {
					const dailyCouponValue = MathUtil.calculateMonthlyNominalInterestRate(this.coupon) / 30.0
							* this.faceValue;
					if (dailyCouponValue > 0) {
						const from = this.couponFromBankAccountDelegate.getBankAccount();
						from.managingBank.transferMoney(from, this.couponToBankAccountDelegate.getBankAccount(),
								dailyCouponValue, "bond coupon");
					}
				}
			});
			this.timeSystemEvents.add(transferCouponEvent);
			timeSystem.addEvent(transferCouponEvent, EVERY, EVERY, EVERY, 0);
		}

		deconstruct() {
			super.deconstruct();
			this.simulation.timeSystem.removeEvents(this.timeSystemEvents);
		}

		resetOwner() {
			super.resetOwner();
			this.faceValueToBankAccountDelegate = null;
			this.couponToBankAccountDelegate = null;
		}
	}

	/**
	 * Port of PropertyDAOImpl
	 */
	class PropertyDAO {
		constructor() {
			this.byOwner = new Map();
			this.byIssuer = new Map();
		}

		static addTo(map, key, property) {
			let properties = map.get(key);
			if (!properties) {
				properties = new Set();
				map.set(key, properties);
			}
			properties.add(property);
		}

		static removeFrom(map, key, property) {
			const properties = map.get(key);
			if (properties) {
				properties.delete(property);
				if (properties.size === 0) {
					map.delete(key);
				}
			}
		}

		save(property) {
			PropertyDAO.addTo(this.byOwner, property.owner, property);
			if (property instanceof PropertyIssued) {
				PropertyDAO.addTo(this.byIssuer, property.issuer, property);
			}
		}

		delete(property) {
			PropertyDAO.removeFrom(this.byOwner, property.owner, property);
			if (property instanceof PropertyIssued) {
				PropertyDAO.removeFrom(this.byIssuer, property.issuer, property);
			}
		}

		findAllPropertiesIssuedByAgent(issuer, propertyClass) {
			const properties = this.byIssuer.get(issuer);
			if (!properties) {
				return [];
			}
			const result = Array.from(properties);
			return propertyClass ? result.filter((property) => property instanceof propertyClass) : result;
		}

		/**
		 * live views without copy, for iterations that do not transfer properties
		 */
		iterateIssuedBy(issuer) {
			return this.byIssuer.get(issuer) || EMPTY_SET;
		}

		iterateOwnedBy(owner) {
			return this.byOwner.get(owner) || EMPTY_SET;
		}

		findAllPropertiesOfPropertyOwner(owner, propertyClass) {
			const properties = this.byOwner.get(owner);
			if (!properties) {
				return [];
			}
			const result = Array.from(properties);
			return propertyClass ? result.filter((property) => property instanceof propertyClass) : result;
		}

		transferProperty(oldOwner, newOwner, property) {
			this.delete(property);
			property.owner = newOwner;
			this.save(property);
		}
	}

	/**
	 * Port of PropertyServiceImpl; good type ownerships are stored at the owner.
	 */
	class PropertyService {
		constructor(simulation) {
			this.simulation = simulation;
			this.dao = new PropertyDAO();
		}

		assureGoodTypeOwnership(propertyOwner) {
			if (!propertyOwner.goodTypeOwnership) {
				propertyOwner.goodTypeOwnership = new Float64Array(GoodType.count);
			}
			return propertyOwner.goodTypeOwnership;
		}

		decrementGoodTypeAmount(propertyOwner, goodType, amount) {
			const ownedGoodTypes = this.assureGoodTypeOwnership(propertyOwner);
			const newBalance = Math.max(ownedGoodTypes[goodType.ordinal] - amount, 0);
			ownedGoodTypes[goodType.ordinal] = newBalance;
			return newBalance;
		}

		incrementGoodTypeAmount(propertyOwner, goodType, amount) {
			const ownedGoodTypes = this.assureGoodTypeOwnership(propertyOwner);
			ownedGoodTypes[goodType.ordinal] += amount;
			return ownedGoodTypes[goodType.ordinal];
		}

		resetGoodTypeAmount(propertyOwner, goodType) {
			this.assureGoodTypeOwnership(propertyOwner)[goodType.ordinal] = 0.0;
		}

		getGoodTypeBalance(propertyOwner, goodType) {
			return this.assureGoodTypeOwnership(propertyOwner)[goodType.ordinal];
		}

		getGoodTypeBalances(propertyOwner) {
			return Float64Array.from(this.assureGoodTypeOwnership(propertyOwner));
		}

		/**
		 * @return balances of durable good types, indexed by good type ordinal;
		 *         undefined for non-durable good types
		 */
		getCapitalBalances(propertyOwner) {
			const balances = this.assureGoodTypeOwnership(propertyOwner);
			const capital = new Map();
			for (const goodType of GoodType.values()) {
				if (goodType.durable) {
					capital.set(goodType, balances[goodType.ordinal]);
				}
			}
			return capital;
		}

		transferGoodTypeAmount(goodType, oldOwner, newOwner, amount) {
			this.decrementGoodTypeAmount(oldOwner, goodType, amount);
			this.incrementGoodTypeAmount(newOwner, goodType, amount);
		}

		deleteProperty(property) {
			this.dao.delete(property);
		}

		findAllPropertiesIssuedByAgent(issuer, propertyClass) {
			return this.dao.findAllPropertiesIssuedByAgent(issuer, propertyClass);
		}

		findAllPropertiesOfPropertyOwner(owner, propertyClass) {
			return this.dao.findAllPropertiesOfPropertyOwner(owner, propertyClass);
		}

		transferProperty(property, oldOwner, newOwner) {
			property.resetOwner();
			this.dao.transferProperty(oldOwner, newOwner, property);
			if (oldOwner) {
				oldOwner.onPropertyTransferred(property, oldOwner, newOwner);
			}
			if (newOwner) {
				newOwner.onPropertyTransferred(property, oldOwner, newOwner);
			}
		}

		transferEverythingToRandomAgent(oldOwner) {
			if (!oldOwner) {
				return;
			}
			const households = this.simulation.households;
			let newOwnerHousehold = null;
			while ((newOwnerHousehold === null || oldOwner === newOwnerHousehold) && households.length > 1) {
				newOwnerHousehold = households.items[this.simulation.random.nextInt(households.length)];
			}
			if (newOwnerHousehold !== null && oldOwner.goodTypeOwnership) {
				this.assureGoodTypeOwnership(newOwnerHousehold);
				for (const goodType of GoodType.values()) {
					if (goodType !== LABOURHOUR) {
						this.transferGoodTypeAmount(goodType, oldOwner, newOwnerHousehold,
								oldOwner.goodTypeOwnership[goodType.ordinal]);
					}
				}
			}
			for (const property of this.dao.findAllPropertiesOfPropertyOwner(oldOwner)) {
				this.transferProperty(property, oldOwner, newOwnerHousehold);
			}
			oldOwner.goodTypeOwnership = null;
		}
	}

	/*
	 * banking
	 */

	class BankAccount {
		constructor(id) {
			this.id = id;
			this.balance = 0.0;
			this.currency = null;
			this.managingBank = null;
			this.moneyType = null;
			this.name = null;
			this.overdraftPossible = true;
			this.owner = null;
			this.termType = null;
		}

		deposit(amount) {
			this.balance = this.balance + amount;
		}

		withdraw(amount) {
			this.balance = this.balance - amount;
		}
	}

	/**
	 * Port of BankAccountDAOImpl
	 */
	class BankAccountDAO {
		constructor() {
			this.byBank = new Map();
			this.byOwner = new Map();
		}

		save(bankAccount) {
			let ofBank = this.byBank.get(bankAccount.managingBank);
			if (!ofBank) {
				ofBank = new Set();
				this.byBank.set(bankAccount.managingBank, ofBank);
			}
			ofBank.add(bankAccount);
			let ofOwner = this.byOwner.get(bankAccount.owner);
			if (!ofOwner) {
				ofOwner = new Set();
				this.byOwner.set(bankAccount.owner, ofOwner);
			}
			ofOwner.add(bankAccount);
		}

		delete(bankAccount) {
			const ofBank = this.byBank.get(bankAccount.managingBank);
			if (ofBank) {
				ofBank.delete(bankAccount);
			}
			const ofOwner = this.byOwner.get(bankAccount.owner);
			if (ofOwner) {
				ofOwner.delete(bankAccount);
				if (ofOwner.size === 0) {
					this.byOwner.delete(bankAccount.owner);
				}
			}
		}

		deleteAllBankAccounts(managingBank, owner) {
			if (owner === undefined) {
				const ofBank = this.byBank.get(managingBank);
				if (ofBank) {
					for (const bankAccount of Array.from(ofBank)) {
						this.delete(bankAccount);
					}
				}
				this.byBank.delete(managingBank);
				return;
			}
			const ofOwner = this.byOwner.get(owner);
			if (ofOwner) {
				for (const bankAccount of Array.from(ofOwner)) {
					if (bankAccount.managingBank === managingBank) {
						this.delete(bankAccount);
					}
				}
			}
		}

		findAll(managingBank, owner) {
			const ofOwner = this.byOwner.get(owner);
			if (!ofOwner) {
				return [];
			}
			return Array.from(ofOwner).filter((bankAccount) => bankAccount.managingBank === managingBank);
		}

		findAllBankAccountsManagedByBank(managingBank) {
			const ofBank = this.byBank.get(managingBank);
			return ofBank ? Array.from(ofBank) : [];
		}

		/**
		 * live view without copy, for read-only iteration
		 */
		iterateBankAccountsManagedByBank(managingBank) {
			return this.byBank.get(managingBank) || [];
		}

		findAllBankAccountsOfAgent(owner) {
			const ofOwner = this.byOwner.get(owner);
			return ofOwner ? Array.from(ofOwner) : [];
		}
	}

	class HardCashService {
		constructor() {
			this.balances = new Map();
		}

		getBalance(owner, currency) {
			const balances = this.balances.get(owner);
			return balances && balances[currency.name] ? balances[currency.name] : 0.0;
		}

		increment(owner, currency, amount) {
			const balances = this.balances.get(owner) || {};
			balances[currency.name] = (balances[currency.name] || 0.0) + amount;
			this.balances.set(owner, balances);
			return balances[currency.name];
		}

		decrement(owner, currency, amount) {
			return this.increment(owner, currency, -amount);
		}

		deregister(owner) {
			this.balances.delete(owner);
		}
	}

	function bankAccountDelegate(getBankAccount, onTransfer) {
		return { getBankAccount, onTransfer: onTransfer || (() => {}) };
	}

	/*
	 * behaviours
	 */

	const PricingBehaviourNewPriceDecisionCause = {
		IMPLICIT_RAISE: "IMPLICIT_RAISE",
		SOLD_EVERYTHING: "SOLD_EVERYTHING",
		SOLD_LESS: "SOLD_LESS",
		SOLD_MORE: "SOLD_MORE",
		SOLD_NOTHING: "SOLD_NOTHING",
	};

	/**
	 * Port of PricingBehaviourImpl
	 */
	class PricingBehaviour {
		constructor(agent, offeredObject, denominatedInCurrency, initialPrice, priceChangeIncrement) {
			const config = agent.simulation.configuration.pricingBehaviourConfig;
			this.agent = agent;
			this.offeredObject = offeredObject;
			this.denominatedInCurrency = denominatedInCurrency;
			this.initialPrice = initialPrice;
			this.initialPriceChangeIncrement = priceChangeIncrement === undefined
				? config.defaultPriceChangeIncrementExplicit
				: priceChangeIncrement;
			this.priceChangeIncrement = 0.0;
			this.periodDataInitialized = false;
			// index 0 = current period, 1 = last period, ...
			this.offeredAmount_InPeriods = new Float64Array(10);
			this.prices_InPeriods = new Float64Array(10);
			this.soldAmount_InPeriods = new Float64Array(10);
			this.soldValue_InPeriods = new Float64Array(10);
		}

		get config() {
			return this.agent.simulation.configuration.pricingBehaviourConfig;
		}

		assurePeriodDataInitialized() {
			if (!this.periodDataInitialized) {
				if (Number.isFinite(this.initialPrice)) {
					this.prices_InPeriods[0] = this.initialPrice;
				} else {
					this.prices_InPeriods[0] = this.config.defaultInitialPrice;
				}
				this.periodDataInitialized = true;
			}
		}

		calculateHigherPriceExplicit(price) {
			this.updatePriceChangeIncrement(true);
			if (MathUtil.lesserEqual(price, 0.0)) {
				return 0.0001;
			}
			return price * (1.0 + this.priceChangeIncrement);
		}

		calculateHigherPriceImplicit(price) {
			return price * (1.0 + this.config.defaultPriceChangeIncrementImplicit);
		}

		calculateLowerPriceExplicit(price) {
			this.updatePriceChangeIncrement(false);
			return price / (1.0 + this.priceChangeIncrement);
		}

		calculateNewPrice() {
			const log = this.agent.simulation.log;
			const oldPrice = this.prices_InPeriods[1];
			const offeredAmountInLastPeriod = this.offeredAmount_InPeriods[1];
			const offeredAmountInPenultimatePeriod = this.offeredAmount_InPeriods[2];
			const soldAmountInLastPeriod = this.soldAmount_InPeriods[1];
			const soldAmountInPenultimatePeriod = this.soldAmount_InPeriods[2];

			// sold nothing -> lower price
			if (MathUtil.greater(offeredAmountInLastPeriod, 0.0) && MathUtil.lesserEqual(soldAmountInLastPeriod, 0.0)) {
				const newPrice = this.calculateLowerPriceExplicit(oldPrice);
				log.pricingBehaviour_onCalculateNewPrice(this.agent, PricingBehaviourNewPriceDecisionCause.SOLD_NOTHING,
						-1.0 * this.priceChangeIncrement);
				return newPrice;
			}
			// sold everything -> raise price
			if (MathUtil.greater(offeredAmountInLastPeriod, 0.0)
					&& MathUtil.equal(soldAmountInLastPeriod, offeredAmountInLastPeriod)) {
				const newPrice = this.calculateHigherPriceExplicit(oldPrice);
				log.pricingBehaviour_onCalculateNewPrice(this.agent,
						PricingBehaviourNewPriceDecisionCause.SOLD_EVERYTHING, this.priceChangeIncrement);
				return newPrice;
			}
			// sold less -> lower price
			if (MathUtil.greater(offeredAmountInLastPeriod, 0.0)
					&& MathUtil.greater(soldAmountInPenultimatePeriod, 0.0)
					&& MathUtil.lesser(soldAmountInLastPeriod, soldAmountInPenultimatePeriod)
					&& MathUtil.greaterEqual(offeredAmountInLastPeriod, soldAmountInPenultimatePeriod)) {
				const newPrice = this.calculateLowerPriceExplicit(oldPrice);
				log.pricingBehaviour_onCalculateNewPrice(this.agent, PricingBehaviourNewPriceDecisionCause.SOLD_LESS,
						-1.0 * this.priceChangeIncrement);
				return newPrice;
			}
			// sold more -> raise price
			if (MathUtil.greater(offeredAmountInLastPeriod, 0.0)
					&& MathUtil.greater(soldAmountInPenultimatePeriod, 0.0)
					&& MathUtil.greater(soldAmountInLastPeriod, soldAmountInPenultimatePeriod)
					&& MathUtil.greaterEqual(offeredAmountInPenultimatePeriod, soldAmountInLastPeriod)) {
				const newPrice = this.calculateHigherPriceExplicit(oldPrice);
				log.pricingBehaviour_onCalculateNewPrice(this.agent, PricingBehaviourNewPriceDecisionCause.SOLD_MORE,
						this.priceChangeIncrement);
				return newPrice;
			}
			log.pricingBehaviour_onCalculateNewPrice(this.agent, PricingBehaviourNewPriceDecisionCause.IMPLICIT_RAISE,
					this.config.defaultPriceChangeIncrementImplicit);
			return this.calculateHigherPriceImplicit(oldPrice);
		}

		getCurrentPrice() {
			return this.prices_InPeriods[0];
		}

		getCurrentPriceArray() {
			const numberOfPrices = this.config.defaultNumberOfPrices;
			const prices = new Array(numberOfPrices);
			if (numberOfPrices === 1) {
				prices[0] = this.getCurrentPrice();
			} else {
				const minPrice = Math.max(0, this.getCurrentPrice() - this.priceChangeIncrement);
				const maxPrice = this.getCurrentPrice() + this.priceChangeIncrement;
				const priceGap = (maxPrice - minPrice) / (numberOfPrices - 1.0);
				for (let i = 0; i < numberOfPrices; i++) {
					prices[i] = minPrice + priceGap * i;
				}
			}
			return prices;
		}

		getLastOfferedAmount() {
			return this.offeredAmount_InPeriods[1];
		}

		getLastSoldAmount() {
			return this.soldAmount_InPeriods[1];
		}

		getLastSoldValue() {
			return this.soldValue_InPeriods[1];
		}

		nextPeriod() {
			this.assurePeriodDataInitialized();
			this.prices_InPeriods.copyWithin(1, 0, 9);
			this.soldAmount_InPeriods.copyWithin(1, 0, 9);
			this.soldValue_InPeriods.copyWithin(1, 0, 9);
			this.offeredAmount_InPeriods.copyWithin(1, 0, 9);
			this.offeredAmount_InPeriods[0] = 0.0;
			this.soldAmount_InPeriods[0] = 0.0;
			this.soldValue_InPeriods[0] = 0.0;
			this.prices_InPeriods[0] = this.calculateNewPrice();
		}

		registerOfferedAmount(numberOfProducts) {
			if (Number.isFinite(numberOfProducts)) {
				this.offeredAmount_InPeriods[0] += numberOfProducts;
			}
		}

		registerSelling(numberOfProducts, totalValue) {
			if (Number.isFinite(numberOfProducts)) {
				this.soldAmount_InPeriods[0] += numberOfProducts;
				this.soldValue_InPeriods[0] += totalValue;
			}
		}

		updatePriceChangeIncrement(raisingPrice) {
			if (MathUtil.lesserEqual(this.priceChangeIncrement, 0.0)) {
				this.priceChangeIncrement = this.initialPriceChangeIncrement;
			}
			const priceInLastPeriod = this.prices_InPeriods[1];
			const priceInPenultimatePeriod = this.prices_InPeriods[2];
			if (raisingPrice) {
				// rising trend -> accelerate; trend reversal -> decelerate
				if (MathUtil.greater(priceInLastPeriod, priceInPenultimatePeriod)) {
					this.priceChangeIncrement = Math.min(this.initialPriceChangeIncrement, this.priceChangeIncrement * 1.1);
				} else if (MathUtil.lesser(priceInLastPeriod, priceInPenultimatePeriod)) {
					this.priceChangeIncrement = Math.min(this.initialPriceChangeIncrement, this.priceChangeIncrement / 1.1);
				}
			} else {
				if (MathUtil.lesser(priceInLastPeriod, priceInPenultimatePeriod)) {
					this.priceChangeIncrement = Math.min(this.initialPriceChangeIncrement, this.priceChangeIncrement * 1.1);
				} else if (MathUtil.greater(priceInLastPeriod, priceInPenultimatePeriod)) {
					this.priceChangeIncrement = Math.min(this.initialPriceChangeIncrement, this.priceChangeIncrement / 1.1);
				}
			}
		}
	}

	/**
	 * Port of BudgetingBehaviourImpl: maxCredit defines the maximum additional
	 * debt the buyer is going to accept -> nexus with the monetary sphere
	 */
	class BudgetingBehaviour {
		constructor(agent) {
			this.agent = agent;
			this.lastMaxCreditRate = NaN;
		}

		calculateTransmissionBasedBudgetForPeriod(currency, bankAccountBalance, referenceCredit) {
			const simulation = this.agent.simulation;
			if (Number.isNaN(this.lastMaxCreditRate)) {
				this.lastMaxCreditRate = referenceCredit;
			}
			const keyInterestRate = simulation.findCentralBank(currency).effectiveKeyInterestRate;
			const config = simulation.configuration.budgetingBehaviourConfig;
			this.lastMaxCreditRate = this.lastMaxCreditRate
					* (1.0 + ((config.internalRateOfReturn - keyInterestRate) / config.keyInterestRateTransmissionDamper));
			// transmission mechanism
			return Math.max(0.0, bankAccountBalance + this.lastMaxCreditRate);
		}

		getCreditBasedBudgetCapacity() {
			return this.lastMaxCreditRate;
		}
	}

	/*
	 * balance sheets
	 */

	class BalanceSheetDTO {
		constructor(referenceCurrency) {
			this.referenceCurrency = referenceCurrency;
			// assets
			this.hardCash = 0;
			this.cashGiroShortTerm = 0;
			this.cashGiroLongTerm = 0;
			this.cashCentralBankShortTerm = 0;
			this.cashCentralBankLongTerm = 0;
			this.cashForeignCurrency = 0;
			this.bankLoans = 0;
			this.bonds = 0;
			this.inventoryValue = 0;
			this.inventoryQuantitative = null;
			// liabilities
			this.loansGiroShortTerm = 0;
			this.loansGiroLongTerm = 0;
			this.loansCentralBankShortTerm = 0;
			this.loansCentralBankLongTerm = 0;
			this.financialLiabilities = 0;
			this.bankBorrowings = 0;
			// equity
			this.issuedCapital = 0;
		}

		addBankAccountBalance(bankAccount) {
			if (bankAccount) {
				if (bankAccount.balance > 0.0) {
					this.addCash(bankAccount.moneyType, bankAccount.termType, bankAccount.balance);
				} else {
					this.addLoan(bankAccount.moneyType, bankAccount.termType, -1.0 * bankAccount.balance);
				}
			}
		}

		addCash(moneyType, termType, value) {
			if (moneyType === MoneyType.DEPOSITS) {
				if (termType === TermType.SHORT_TERM) {
					this.cashGiroShortTerm += value;
				} else {
					this.cashGiroLongTerm += value;
				}
			} else if (termType === TermType.SHORT_TERM) {
				this.cashCentralBankShortTerm += value;
			} else {
				this.cashCentralBankLongTerm += value;
			}
		}

		addLoan(moneyType, termType, value) {
			if (moneyType === MoneyType.DEPOSITS) {
				if (termType === TermType.SHORT_TERM) {
					this.loansGiroShortTerm += value;
				} else {
					this.loansGiroLongTerm += value;
				}
			} else if (termType === TermType.SHORT_TERM) {
				this.loansCentralBankShortTerm += value;
			} else {
				this.loansCentralBankLongTerm += value;
			}
		}

		getBalanceActive() {
			return this.hardCash + this.cashGiroShortTerm + this.cashGiroLongTerm + this.cashCentralBankShortTerm
					+ this.cashCentralBankLongTerm + this.cashForeignCurrency + this.bankLoans + this.bonds
					+ this.inventoryValue;
		}

		getEquity() {
			return this.getBalanceActive() - this.loansGiroShortTerm - this.loansGiroLongTerm
					- this.loansCentralBankShortTerm - this.loansCentralBankLongTerm - this.financialLiabilities
					- this.bankBorrowings;
		}
	}

	/*
	 * agents
	 */

	class Agent {
		constructor(simulation) {
			this.simulation = simulation;
			this.id = 0;
			this.isDeconstructed = false;
			this.isInitialized = false;
			this.primaryCurrency = null;
			this.referenceCredit = 0;
			this.timeSystemEvents = new Set();
			this.goodTypeOwnership = null;
			this.bankAccountTransactions = null;
			this.bankAccountTransactionsDelegate = bankAccountDelegate(() => {
				this.assureBankAccountTransactions();
				return this.bankAccountTransactions;
			});
		}

		get agentType() {
			return "Agent";
		}

		assureBankAccountTransactions() {
			if (this.isDeconstructed) {
				return;
			}
			if (this.bankAccountTransactions === null) {
				const randomBank = this.simulation.findRandomCreditBank(this.primaryCurrency);
				this.bankAccountTransactions = randomBank.openBankAccount(this, this.primaryCurrency, true,
						"transactions", TermType.SHORT_TERM, MoneyType.DEPOSITS);
			}
		}

		addEvent(onEvent, year, month, day, hour) {
			const event = new TimeSystemEvent(this, onEvent);
			this.timeSystemEvents.add(event);
			this.simulation.timeSystem.addEvent(event, year, month, day, hour);
			return event;
		}

		addEventEvery(onEvent, exceptHour) {
			const event = new TimeSystemEvent(this, onEvent);
			this.timeSystemEvents.add(event);
			this.simulation.timeSystem.addEventEvery(event, EVERY, EVERY, EVERY, exceptHour);
			return event;
		}

		deconstruct() {
			const simulation = this.simulation;
			this.isDeconstructed = true;
			simulation.log.agent_onDeconstruct(this);
			simulation.timeSystem.removeEvents(this.timeSystemEvents);
			this.timeSystemEvents = new Set();
			simulation.marketService.removeAllSellingOffers(this);
			for (const propertyIssued of simulation.propertyService.findAllPropertiesIssuedByAgent(this)) {
				simulation.propertyService.deleteProperty(propertyIssued);
			}
			simulation.propertyService.transferEverythingToRandomAgent(this);
			for (const bankAccount of simulation.bankAccountDAO.findAllBankAccountsOfAgent(this)) {
				if (bankAccount.owner === this) {
					bankAccount.managingBank.closeCustomerAccount(this);
				}
			}
			simulation.hardCashService.deregister(this);
		}

		getPrimaryBank() {
			this.assureBankAccountTransactions();
			return this.bankAccountTransactions.managingBank;
		}

		initialize() {
			// balance sheet publication
			this.addEvent(() => {
				const balanceSheet = this.issueBalanceSheet();
				this.simulation.log.agent_onLifesign(this);
				this.simulation.log.agent_onPublishBalanceSheet(this, balanceSheet);
			}, EVERY, EVERY, EVERY, this.simulation.configuration.agentConfig.balanceSheetPublicationHourType);
			this.simulation.log.agent_onConstruct(this);
			this.isInitialized = true;
		}

		issueBalanceSheet() {
			const simulation = this.simulation;
			this.assureBankAccountTransactions();
			const referenceCurrency = this.bankAccountTransactions.currency;
			const balanceSheet = new BalanceSheetDTO(referenceCurrency);
			balanceSheet.hardCash = simulation.hardCashService.getBalance(this, referenceCurrency);
			balanceSheet.addBankAccountBalance(this.bankAccountTransactions);
			for (const property of simulation.propertyService.findAllPropertiesOfPropertyOwner(this)) {
				if (property instanceof FixedRateBond) {
					if (property.isDeconstructed) {
						simulation.propertyService.deleteProperty(property);
					} else if (property.issuer !== this) {
						/*
						 * the agent does not take into account bonds, which are issued by the agent
						 * (and have not been sold, yet -> are owned by the agent)
						 */
						balanceSheet.bonds += property.faceValue;
					}
				}
			}
			const prices = simulation.marketService.getMarginalMarketPrices(this.primaryCurrency);
			const balances = simulation.propertyService.getGoodTypeBalances(this);
			for (const goodType of GoodType.values()) {
				const price = prices[goodType.ordinal];
				if (!Number.isNaN(price)) {
					balanceSheet.inventoryValue += balances[goodType.ordinal] * price;
				}
			}
			balanceSheet.inventoryQuantitative = balances;
			for (const propertyIssued of simulation.propertyService.findAllPropertiesIssuedByAgent(this)) {
				if (propertyIssued instanceof FixedRateBond) {
					if (!propertyIssued.isDeconstructed && propertyIssued.owner !== this) {
						balanceSheet.financialLiabilities += propertyIssued.faceValue;
					}
				}
				if (propertyIssued instanceof Share) {
					balanceSheet.issuedCapital++;
				}
			}
			return balanceSheet;
		}

		onBankCloseBankAccount(bankAccount) {
			if (this.bankAccountTransactions === bankAccount) {
				this.bankAccountTransactions = null;
			}
		}

		onPropertyTransferred(property, oldOwner, newOwner) {}

		onMarketSettlementOfCurrency(commodityCurrency, amount, pricePerUnit, currency) {}

		onMarketSettlementOfGoodType(goodType, amount, pricePerUnit, currency) {}

		onMarketSettlementOfProperty(property, pricePerUnit, currency) {}

		toString() {
			return this.agentType + " " + this.id + " (" + this.primaryCurrency.iso4217Code + ")";
		}
	}

	/**
	 * Port of JointStockCompanyImpl
	 */
	class JointStockCompany extends Agent {
		constructor(simulation) {
			super(simulation);
			this.bankAccountDividends = null;
			this.bankAccountDividendsDelegate = bankAccountDelegate(() => {
				this.assureBankAccountDividends();
				return this.bankAccountDividends;
			});
		}

		assureBankAccountDividends() {
			if (this.isDeconstructed) {
				return;
			}
			if (this.bankAccountDividends === null) {
				this.bankAccountDividends = this.getPrimaryBank().openBankAccount(this, this.primaryCurrency, false,
						"dividends", TermType.SHORT_TERM, MoneyType.DEPOSITS);
			}
		}

		initialize() {
			super.initialize();
			this.addEvent(() => this.payDividend(), EVERY, EVERY, EVERY, EVERY);
		}

		payDividend() {
			const propertiesIssued = this.simulation.propertyService.dao.iterateIssuedBy(this);
			let numberOfShares = 0;
			for (const property of propertiesIssued) {
				if (property instanceof Share) {
					numberOfShares++;
				}
			}
			if (numberOfShares === 0) {
				this.issueShares();
				return;
			}
			this.assureBankAccountDividends();
			const totalDividend = this.bankAccountDividends.balance;
			if (MathUtil.greater(totalDividend, 0.0)) {
				const currency = this.bankAccountDividends.currency;
				const dividendPerShare = totalDividend / numberOfShares;
				for (const share of propertiesIssued) {
					if (share instanceof Share && share.owner !== null && share.owner !== this && share.dividendBankAccountDelegate !== null) {
						const dividendBankAccount = share.dividendBankAccountDelegate.getBankAccount();
						if (dividendBankAccount && currency === dividendBankAccount.currency) {
							const dividend = Math.min(dividendPerShare, this.bankAccountDividends.balance);
							this.bankAccountDividends.managingBank.transferMoney(this.bankAccountDividends,
									dividendBankAccount, dividend, "dividend");
							share.dividendBankAccountDelegate.onTransfer(dividendPerShare);
						}
					}
				}
			}
		}

		issueBalanceSheet() {
			this.assureBankAccountDividends();
			const balanceSheet = super.issueBalanceSheet();
			balanceSheet.addBankAccountBalance(this.bankAccountDividends);
			return balanceSheet;
		}

		issueShares() {
			const simulation = this.simulation;
			const numberOfShares = simulation.configuration.jointStockCompanyConfig.initialNumberOfShares;
			for (let i = 0; i < numberOfShares; i++) {
				const share = new Share(simulation, simulation.nextId());
				share.issuer = this;
				share.owner = this;
				simulation.propertyService.dao.save(share);
				simulation.marketService.placeSellingOfferForProperty(share, this, this.bankAccountTransactionsDelegate,
						0.0);
			}
		}

		onBankCloseBankAccount(bankAccount) {
			if (this.bankAccountDividends === bankAccount) {
				this.bankAccountDividends = null;
			}
			super.onBankCloseBankAccount(bankAccount);
		}

		transferBankAccountBalanceToDividendBankAccount(bankAccount) {
			this.assureBankAccountDividends();
			if (MathUtil.greater(bankAccount.balance, 0.0)) {
				bankAccount.managingBank.transferMoney(bankAccount, this.bankAccountDividends, bankAccount.balance,
						"converting profit to dividend");
			}
		}
	}

	/**
	 * Port of BankImpl
	 */
	class Bank extends JointStockCompany {
		constructor(simulation) {
			super(simulation);
			this.bankAccountBondLoan = null;
			this.bankAccountBondLoanDelegate = bankAccountDelegate(() => {
				this.assureBankAccountBondLoan();
				return this.bankAccountBondLoan;
			});
			this.bankAccountInterestTransactions = null;
			this.bankAccountInterestTransactionsDelegate = bankAccountDelegate(() => {
				this.assureBankAccountInterestTransactions();
				return this.bankAccountInterestTransactions;
			});
		}

		assureBankAccountBondLoan() {
			if (this.isDeconstructed) {
				return;
			}
			if (this.bankAccountBondLoan === null) {
				this.bankAccountBondLoan = this.getPrimaryBank().openBankAccount(this, this.primaryCurrency, true,
						"bond loans", TermType.LONG_TERM, MoneyType.DEPOSITS);
			}
		}

		assureBankAccountInterestTransactions() {
			if (this.isDeconstructed) {
				return;
			}
			if (this.bankAccountInterestTransactions === null) {
				this.bankAccountInterestTransactions = this.getPrimaryBank().openBankAccount(this, this.primaryCurrency,
						true, "interest transactions", TermType.SHORT_TERM, MoneyType.DEPOSITS);
			}
		}

		deconstruct() {
			this.isDeconstructed = true;
			for (const customer of this.getCustomers()) {
				this.closeCustomerAccount(customer);
			}
			this.simulation.bankAccountDAO.deleteAllBankAccounts(this);
			super.deconstruct();
		}

		getCustomers() {
			const customers = new Set();
			for (const bankAccount of this.simulation.bankAccountDAO.iterateBankAccountsManagedByBank(this)) {
				customers.add(bankAccount.owner);
			}
			return Array.from(customers);
		}

		getPrimaryBank() {
			return this;
		}

		issueBalanceSheet() {
			this.assureBankAccountBondLoan();
			this.assureBankAccountInterestTransactions();
			const balanceSheet = super.issueBalanceSheet();
			for (const bankAccount of this.simulation.bankAccountDAO.iterateBankAccountsManagedByBank(this)) {
				if (bankAccount.balance > 0.0) {
					// passive account
					balanceSheet.bankBorrowings += bankAccount.balance;
				} else {
					balanceSheet.bankLoans += bankAccount.balance * -1.0;
				}
			}
			balanceSheet.addBankAccountBalance(this.bankAccountBondLoan);
			balanceSheet.addBankAccountBalance(this.bankAccountInterestTransactions);
			return balanceSheet;
		}

		onBankCloseBankAccount(bankAccount) {
			if (this.bankAccountInterestTransactions === bankAccount) {
				this.bankAccountInterestTransactions = null;
			}
			if (this.bankAccountBondLoan === bankAccount) {
				this.bankAccountBondLoan = null;
			}
			super.onBankCloseBankAccount(bankAccount);
		}

		openBankAccount(customer, currency, overdraftPossible, name, termType, moneyType) {
			const bankAccount = new BankAccount(this.simulation.nextId());
			bankAccount.owner = customer;
			bankAccount.overdraftPossible = overdraftPossible;
			bankAccount.currency = currency;
			bankAccount.managingBank = this;
			bankAccount.name = name;
			bankAccount.termType = termType;
			bankAccount.moneyType = moneyType;
			this.simulation.bankAccountDAO.save(bankAccount);
			return bankAccount;
		}
	}

	/**
	 * Port of CentralBankImpl: adjusts key interest rates based on price indices
	 */
	class CentralBank extends Bank {
		constructor(simulation) {
			super(simulation);
			this.bankAccountCentralBankMoney = null;
			this.bankAccountCentralBankMoneyDelegate = bankAccountDelegate(() => {
				this.assureBankAccountCentralBankMoney();
				return this.bankAccountCentralBankMoney;
			});
			this.effectiveKeyInterestRate = 0;
			this.statisticalOffice = null;
		}

		get agentType() {
			return "CentralBank";
		}

		assureBankAccountCentralBankMoney() {
			if (this.isDeconstructed) {
				return;
			}
			if (this.bankAccountCentralBankMoney === null) {
				this.bankAccountCentralBankMoney = this.getPrimaryBank().openBankAccount(this, this.primaryCurrency,
						true, "central bank money", TermType.LONG_TERM, MoneyType.CENTRALBANK_MONEY);
			}
		}

		assureBankAccountTransactions() {
			if (this.isDeconstructed) {
				return;
			}
			if (this.bankAccountTransactions === null) {
				this.bankAccountTransactions = this.getPrimaryBank().openBankAccount(this, this.primaryCurrency, true,
						"transactions", TermType.SHORT_TERM, MoneyType.DEPOSITS);
			}
		}

		closeCustomerAccount(customer) {
			this.assureBankAccountCentralBankMoney();
			for (const bankAccount of this.simulation.bankAccountDAO.findAll(this, customer)) {
				if (bankAccount.moneyType === MoneyType.DEPOSITS) {
					if (this.bankAccountTransactions !== null && bankAccount !== this.bankAccountTransactions) {
						if (bankAccount.balance >= 0) {
							this.transferMoney(bankAccount, this.bankAccountTransactions, bankAccount.balance,
									"evening-up of closed bank account", true);
						} else {
							this.transferMoney(this.bankAccountTransactions, bankAccount, -1.0 * bankAccount.balance,
									"evening-up of closed bank account", true);
						}
					}
				} else if (this.bankAccountCentralBankMoney !== null && bankAccount !== this.bankAccountCentralBankMoney) {
					if (bankAccount.balance >= 0) {
						this.transferMoney(bankAccount, this.bankAccountCentralBankMoney, bankAccount.balance,
								"evening-up of closed bank account", true);
					} else {
						this.transferMoney(this.bankAccountCentralBankMoney, bankAccount, -1.0 * bankAccount.balance,
								"evening-up of closed bank account", true);
					}
				}
				customer.onBankCloseBankAccount(bankAccount);
			}
			this.simulation.bankAccountDAO.deleteAllBankAccounts(this, customer);
		}

		deconstruct() {
			super.deconstruct();
			this.simulation.centralBanks.delete(this.primaryCurrency);
		}

		getAverageMarginalPriceForGoodType(goodType) {
			return this.statisticalOffice.averageMarginalPricesForGoodTypes[goodType.ordinal];
		}

		getReserveRatio() {
			return this.simulation.configuration.centralBankConfig.reserveRatio;
		}

		initialize() {
			super.initialize();
			const config = this.simulation.configuration.centralBankConfig;
			this.addEvent(() => this.onDailyInterestCalculation(), EVERY, EVERY, EVERY, 1);
			/*
			 * the same snapshot event is registered for four hours, but is contained
			 * only once in the set of events of this agent, as in the Java version
			 */
			const marginalPriceSnapshotEvent = this.addEvent(() => this.statisticalOffice.takeSnapshotOfMarginalPrices(),
					EVERY, EVERY, EVERY, 3);
			for (const hour of [9, 15, 21]) {
				this.simulation.timeSystem.addEvent(marginalPriceSnapshotEvent, EVERY, EVERY, EVERY, hour);
			}
			this.addEvent(() => this.onKeyInterestRateCalculation(), EVERY, EVERY, EVERY, 1);
			const numberOfSnapshotsPerDay = 1;
			this.statisticalOffice = new StatisticalOffice(this, numberOfSnapshotsPerDay);
			this.effectiveKeyInterestRate = config.defaultEffectiveKeyInterestRate;
		}

		onDailyInterestCalculation() {
			this.assureBankAccountTransactions();
			const monthlyInterestRate = MathUtil.calculateMonthlyNominalInterestRate(this.effectiveKeyInterestRate);
			const dailyInterestRate = monthlyInterestRate / 30.0;
			for (const bankAccount of this.simulation.bankAccountDAO.findAllBankAccountsManagedByBank(this)) {
				if (bankAccount.owner !== this) {
					const dailyInterest = bankAccount.balance * dailyInterestRate;
					if (dailyInterest > 0.0) {
						this.transferMoneyInternally(this.bankAccountTransactions, bankAccount, dailyInterest);
					} else if (dailyInterest < 0.0) {
						this.transferMoneyInternally(bankAccount, this.bankAccountTransactions, -1.0 * dailyInterest);
					}
				}
			}
			if (this.bankAccountTransactions.balance > 0.0) {
				const state = this.simulation.findState(this.primaryCurrency);
				this.transferMoney(this.bankAccountTransactions, state.bankAccountTransactionsDelegate.getBankAccount(),
						this.bankAccountTransactions.balance, "national interest");
			}
		}

		onKeyInterestRateCalculation() {
			this.statisticalOffice.recalculateAveragePrices();
			this.statisticalOffice.recalculatePriceIndex();
			this.simulation.log.centralBank_PriceIndex(this.primaryCurrency, this.statisticalOffice.priceIndex);
			this.effectiveKeyInterestRate = this.calculateEffectiveKeyInterestRate();
			this.simulation.log.centralBank_KeyInterestRate(this.primaryCurrency, this.effectiveKeyInterestRate);
		}

		calculateEffectiveKeyInterestRate() {
			const config = this.simulation.configuration.centralBankConfig;
			const targetPriceIndexForCurrentPeriod = this.calculateTargetPriceIndexForPeriod();
			const currentPriceIndex = this.statisticalOffice.priceIndex;
			const newEffectiveKeyInterestRate = config.defaultEffectiveKeyInterestRate
					+ (((currentPriceIndex - targetPriceIndexForCurrentPeriod) / currentPriceIndex) / 10.0);
			if (!Number.isFinite(newEffectiveKeyInterestRate)) {
				return config.defaultEffectiveKeyInterestRate;
			}
			return Math.max(Math.min(newEffectiveKeyInterestRate, config.maxEffectiveKeyInterestRate),
					config.minEffectiveKeyInterestRate);
		}

		calculateTargetPriceIndexForPeriod() {
			const config = this.simulation.configuration.centralBankConfig;
			const timeSystem = this.simulation.timeSystem;
			const yearNumber = timeSystem.getCurrentYear() - timeSystem.startYear;
			const targetPriceLevelForYear = Math.pow(1.0 + config.inflationTarget, yearNumber);
			const monthlyNominalInflationTarget = MathUtil.calculateMonthlyNominalInterestRate(config.inflationTarget);
			const targetPriceLevelForMonth = Math.pow(1.0 + monthlyNominalInflationTarget,
					timeSystem.getCurrentMonthNumberInYear() - 1.0) - 1.0;
			const targetPriceLevelForDay = (monthlyNominalInflationTarget / 30.0) * timeSystem.getCurrentDayNumberInMonth();
			return config.targetPriceIndex * (targetPriceLevelForYear + targetPriceLevelForMonth + targetPriceLevelForDay);
		}

		issueBalanceSheet() {
			this.assureBankAccountCentralBankMoney();
			const balanceSheet = super.issueBalanceSheet();
			balanceSheet.addBankAccountBalance(this.bankAccountCentralBankMoney);
			return balanceSheet;
		}

		obtainTender(moneyReservesBankAccount, bonds) {
			this.assureBankAccountCentralBankMoney();
			for (const bond of bonds) {
				moneyReservesBankAccount.deposit(bond.faceValue);
				this.simulation.propertyService.transferProperty(bond, bond.owner, this);
				bond.faceValueToBankAccountDelegate = this.bankAccountCentralBankMoneyDelegate;
				bond.couponToBankAccountDelegate = this.bankAccountCentralBankMoneyDelegate;
			}
		}

		onBankCloseBankAccount(bankAccount) {
			if (this.bankAccountCentralBankMoney === bankAccount) {
				this.bankAccountCentralBankMoney = null;
			}
			super.onBankCloseBankAccount(bankAccount);
		}

		transferMoney(from, to, amount, subject, negativeAmountOK) {
			if (from.managingBank instanceof CentralBank && to.managingBank instanceof CentralBank) {
				this.simulation.log.bank_onTransfer(from, to, from.currency, amount, subject);
				this.transferMoneyInternally(from, to, amount);
			} else if (from.managingBank instanceof CreditBank && to.managingBank instanceof CentralBank) {
				// credit bank account -> central bank account
				from.managingBank.withdraw(from, amount);
				to.deposit(amount);
			} else if (from.managingBank instanceof CentralBank && to.managingBank instanceof CreditBank) {
				// central bank account -> credit bank account
				from.withdraw(amount);
				to.managingBank.deposit(to, amount);
			} else {
				throw new Error("uncovered case");
			}
		}

		transferMoneyInternally(from, to, amount) {
			from.withdraw(amount);
			to.deposit(amount);
		}
	}

	class StatisticalOffice {
		constructor(centralBank, numberOfMarginalPriceSnapshotsPerDay) {
			const NUMBER_OF_LOGGED_PERIODS = 3;
			this.centralBank = centralBank;
			this.priceIndex = 0.0;
			/*
			 * set price index weights, must sum up to 1.0; prices are stored for all
			 * good types, not only those in the price index
			 */
			const weights = centralBank.simulation.configuration.centralBankConfig.statisticalOfficeConfig
				.priceIndexWeights;
			this.priceIndexWeights = GoodType.values().map((goodType) => weights[goodType.name] || 0.0);
			this.monitoredMarginalPricesForGoodTypesAndPeriods = GoodType.values().map(
					() => new Float64Array(NUMBER_OF_LOGGED_PERIODS * numberOfMarginalPriceSnapshotsPerDay));
			this.averageMarginalPricesForGoodTypes = GoodType.values().map(() => NaN);
		}

		recalculateAveragePrices() {
			for (const goodType of GoodType.values()) {
				const monitoredMarginalPrices = this.monitoredMarginalPricesForGoodTypesAndPeriods[goodType.ordinal];
				let priceSum = 0.0;
				let totalWeight = 0;
				for (let i = 0; i < monitoredMarginalPrices.length; i++) {
					const marginalPrice = monitoredMarginalPrices[i];
					if (marginalPrice !== 0.0 && Number.isFinite(marginalPrice)) {
						const weight = monitoredMarginalPrices.length - i;
						priceSum += marginalPrice * weight;
						totalWeight += weight;
					}
				}
				const averagePrice = priceSum / totalWeight;
				if (Number.isFinite(totalWeight)) {
					this.averageMarginalPricesForGoodTypes[goodType.ordinal] = averagePrice;
				}
			}
		}

		recalculatePriceIndex() {
			let newPriceIndex = NaN;
			for (const goodType of GoodType.values()) {
				const weight = this.priceIndexWeights[goodType.ordinal];
				const newPriceIndexForGoodType = weight * this.averageMarginalPricesForGoodTypes[goodType.ordinal];
				if (Number.isFinite(newPriceIndexForGoodType)) {
					if (!Number.isFinite(newPriceIndex)) {
						newPriceIndex = newPriceIndexForGoodType;
					} else {
						newPriceIndex += newPriceIndexForGoodType;
					}
				}
			}
			this.priceIndex = newPriceIndex;
		}

		takeSnapshotOfMarginalPrices() {
			const marketService = this.centralBank.simulation.marketService;
			for (const goodType of GoodType.values()) {
				const prices = this.monitoredMarginalPricesForGoodTypesAndPeriods[goodType.ordinal];
				const marginalPrice = marketService.getMarginalMarketPrice(this.centralBank.primaryCurrency, goodType);
				if (Number.isFinite(marginalPrice)) {
					prices.copyWithin(1, 0, prices.length - 1);
					prices[0] = marginalPrice;
				}
			}
		}
	}

	/**
	 * Port of CreditBankImpl: manages bank accounts, creates money by credit,
	 * trades currencies, follows minimum reserve requirements of central banks
	 * and buys bonds for deposits (fractional reserve banking)
	 */
	class CreditBank extends Bank {
		constructor(simulation) {
			super(simulation);
			this.bankAccountCentralBankMoneyReserves = null;
			this.bankAccountCentralBankMoneyReservesDelegate = bankAccountDelegate(() => {
				this.assureBankAccountCentralBankMoneyReserves();
				return this.bankAccountCentralBankMoneyReserves;
			});
			this.bankAccountCentralBankTransactions = null;
			this.bankAccountsCurrencyTrade = new Map();
			this.bankAccountsCurrencyTradeDelegate = new Map();
			this.localCurrencyPricingBehaviours = new Map();
		}

		get agentType() {
			return "CreditBank";
		}

		assureBankAccountCentralBankMoneyReserves() {
			if (this.isDeconstructed) {
				return;
			}
			if (this.bankAccountCentralBankMoneyReserves === null) {
				this.bankAccountCentralBankMoneyReserves = this.simulation.findCentralBank(this.primaryCurrency)
					.openBankAccount(this, this.primaryCurrency, true, "central bank money reserves", TermType.LONG_TERM,
							MoneyType.CENTRALBANK_MONEY);
			}
		}

		assureBankAccountCentralBankTransactions() {
			if (this.isDeconstructed) {
				return;
			}
			if (this.bankAccountCentralBankTransactions === null) {
				this.bankAccountCentralBankTransactions = this.simulation.findCentralBank(this.primaryCurrency)
					.openBankAccount(this, this.primaryCurrency, true, "central bank transactions", TermType.SHORT_TERM,
							MoneyType.DEPOSITS);
			}
		}

		assureBankAccountsCurrencyTrade() {
			if (this.isDeconstructed) {
				return;
			}
			for (const currency of Currency.values()) {
				if (!this.bankAccountsCurrencyTrade.has(currency)) {
					if (currency !== this.primaryCurrency) {
						const foreignCurrencyCreditBank = this.simulation.findRandomCreditBank(currency);
						if (foreignCurrencyCreditBank) {
							this.bankAccountsCurrencyTrade.set(currency, foreignCurrencyCreditBank.openBankAccount(this,
									currency, true, "currency trade (foreign)", TermType.SHORT_TERM, MoneyType.DEPOSITS));
						}
					} else {
						this.bankAccountsCurrencyTrade.set(currency, this.openBankAccount(this, currency, true,
								"currency trade (local)", TermType.SHORT_TERM, MoneyType.DEPOSITS));
					}
				}
			}
		}

		assureBankAccountTransactions() {
			if (this.isDeconstructed) {
				return;
			}
			if (this.bankAccountTransactions === null) {
				this.bankAccountTransactions = this.getPrimaryBank().openBankAccount(this, this.primaryCurrency, true,
						"transactions", TermType.SHORT_TERM, MoneyType.DEPOSITS);
			}
		}

		/**
		 * currencies of currency trade bank accounts in enum order
		 */
		getCurrencyTradeCurrencies() {
			return Currency.values().filter((currency) => this.bankAccountsCurrencyTrade.has(currency));
		}

		closeCustomerAccount(customer) {
			this.assureBankAccountTransactions();
			for (const bankAccount of this.simulation.bankAccountDAO.findAll(this, customer)) {
				if (!this.isDeconstructed && this.bankAccountTransactions !== null) {
					if (bankAccount !== this.bankAccountTransactions) {
						if (bankAccount.balance >= 0) {
							this.transferMoney(bankAccount, this.bankAccountTransactions, bankAccount.balance,
									"evening-up of closed bank account");
						} else {
							this.transferMoney(this.bankAccountTransactions, bankAccount, -1.0 * bankAccount.balance,
									"evening-up of closed bank account");
						}
					}
				}
				customer.onBankCloseBankAccount(bankAccount);
			}
			if (this.bankAccountTransactions !== null) {
				this.transferBankAccountBalanceToDividendBankAccount(this.bankAccountTransactions);
			}
			this.simulation.bankAccountDAO.deleteAllBankAccounts(this, customer);
		}

		deconstruct() {
			super.deconstruct();
			this.simulation.removeCreditBank(this);
		}

		deposit(bankAccount, amount) {
			bankAccount.deposit(amount);
		}

		withdraw(bankAccount, amount) {
			bankAccount.withdraw(amount);
		}

		getBankAccountCurrencyTradeDelegate(currency) {
			return this.bankAccountsCurrencyTradeDelegate.get(currency);
		}

		getSumOfBorrowings(currency) {
			let sumOfBorrowings = 0;
			for (const bankAccount of this.simulation.bankAccountDAO.iterateBankAccountsManagedByBank(this)) {
				if (bankAccount.currency === currency && bankAccount.balance > 0.0) {
					sumOfBorrowings += bankAccount.balance;
				}
			}
			return sumOfBorrowings;
		}

		initialize() {
			super.initialize();
			const simulation = this.simulation;
			this.addEvent(() => this.onCurrencyTrade(), EVERY, EVERY, EVERY, simulation.timeSystem.suggestRandomHourType());
			this.addEvent(() => this.onDailyInterestCalculation(), EVERY, EVERY, EVERY, 2);
			this.addEvent(() => this.onCheckMoneyReserves(), EVERY, EVERY, EVERY, 12);
			this.addEventEvery(() => this.onBondsTrading(), EVERY);
			for (const foreignCurrency of Currency.values()) {
				if (foreignCurrency !== this.primaryCurrency) {
					let initialPriceOfLocalCurrencyInForeignCurrency = simulation.marketService
						.getMarginalMarketPriceOfCurrency(foreignCurrency, this.primaryCurrency);
					if (Number.isNaN(initialPriceOfLocalCurrencyInForeignCurrency)) {
						initialPriceOfLocalCurrencyInForeignCurrency = 1.0;
					}
					this.localCurrencyPricingBehaviours.set(foreignCurrency, new PricingBehaviour(this,
							this.primaryCurrency, foreignCurrency, initialPriceOfLocalCurrencyInForeignCurrency,
							simulation.configuration.creditBankConfig.priceChangeIncrement));
				}
			}
			for (const currency of Currency.values()) {
				this.bankAccountsCurrencyTradeDelegate.set(currency, bankAccountDelegate(() => {
					this.assureBankAccountsCurrencyTrade();
					return this.bankAccountsCurrencyTrade.get(currency);
				}));
			}
		}

		/*
		 * bonds trading: fractional reserve banking -> buy bonds for passive bank
		 * accounts
		 */
		onBondsTrading() {
			const simulation = this.simulation;
			this.assureBankAccountBondLoan();
			this.assureBankAccountInterestTransactions();
			// transfer received coupons to dividends bank account, so that money is not hoarded
			this.transferBankAccountBalanceToDividendBankAccount(this.bankAccountInterestTransactions);
			let balanceSumOfPassiveBankAccounts = 0.0;
			for (const bankAccount of simulation.bankAccountDAO.iterateBankAccountsManagedByBank(this)) {
				if (bankAccount.balance > 0.0 && bankAccount.termType === TermType.LONG_TERM) {
					balanceSumOfPassiveBankAccounts += bankAccount.balance;
				}
			}
			let faceValueSumOfBonds = 0.0;
			for (const bond of simulation.propertyService.dao.iterateOwnedBy(this)) {
				if (bond instanceof FixedRateBond && !bond.isDeconstructed && bond.issuer !== this) {
					faceValueSumOfBonds += bond.faceValue;
				}
			}
			const difference = balanceSumOfPassiveBankAccounts - faceValueSumOfBonds;
			if (MathUtil.greater(difference, 0.0)) {
				const fixedRateBond = simulation.findState(this.primaryCurrency).obtainBond(difference, this,
						this.bankAccountBondLoanDelegate);
				fixedRateBond.faceValueToBankAccountDelegate = this.bankAccountBondLoanDelegate;
				fixedRateBond.couponToBankAccountDelegate = this.bankAccountInterestTransactionsDelegate;
			}
		}

		onCheckMoneyReserves() {
			const simulation = this.simulation;
			this.assureBankAccountCentralBankMoneyReserves();
			const centralBank = simulation.findCentralBank(this.primaryCurrency);
			const sumOfBorrowings = this.getSumOfBorrowings(this.primaryCurrency);
			const moneyReserveGap = sumOfBorrowings * centralBank.getReserveRatio()
					- this.bankAccountCentralBankMoneyReserves.balance;
			if (moneyReserveGap > 0.0) {
				/*
				 * issue bond; mega bond that covers complete moneyReserveGap; no split up per
				 * 100 currency units, as one mega bond takes less memory and CPU performance
				 */
				const bond = simulation.newFixedRateBond(this, this, this.primaryCurrency,
						this.bankAccountCentralBankMoneyReservesDelegate, this.bankAccountCentralBankMoneyReservesDelegate,
						moneyReserveGap, centralBank.effectiveKeyInterestRate + 0.02);
				centralBank.obtainTender(this.bankAccountCentralBankMoneyReserves, [bond]);
			}
		}

		onDailyInterestCalculation() {
			const simulation = this.simulation;
			this.assureBankAccountInterestTransactions();
			this.assureBankAccountCentralBankTransactions();
			const monthlyInterestRate = MathUtil.calculateMonthlyNominalInterestRate(
					simulation.findCentralBank(this.primaryCurrency).effectiveKeyInterestRate);
			const dailyInterestRate = monthlyInterestRate / 30.0;
			for (const bankAccount of simulation.bankAccountDAO.findAllBankAccountsManagedByBank(this)) {
				if (bankAccount.owner !== this) {
					const dailyInterest = bankAccount.balance * dailyInterestRate;
					if (dailyInterest > 0.0) {
						this.transferMoney(this.bankAccountInterestTransactions, bankAccount, dailyInterest,
								"interest earned for customer");
					} else if (dailyInterest < 0.0) {
						const absMarginDailyInterest = -1.0 * dailyInterest * 1.5;
						this.transferMoney(bankAccount, this.bankAccountInterestTransactions, absMarginDailyInterest,
								"debt interest from customer");
					}
				}
			}
		}

		/*
		 * currency trade
		 */

		onCurrencyTrade() {
			this.assureBankAccountsCurrencyTrade();
			const numberOfForeignCurrencies = this.bankAccountsCurrencyTrade.size - 1;
			if (numberOfForeignCurrencies > 0) {
				this.buyForeignCurrencyForArbitrage();
				this.rebuyLocalCurrency();
				this.offerLocalCurrency();
				this.offerForeignCurrencies();
			}
		}

		calculateLocalCurrencyBudgetForCurrencyTrading() {
			this.assureBankAccountsCurrencyTrade();
			return (this.simulation.configuration.creditBankConfig.maxCreditForCurrencyTrading
					+ this.bankAccountsCurrencyTrade.get(this.primaryCurrency).balance) / 2.0;
		}

		calculateCalculatoryPriceOfFirstCurrencyInSecondCurrency(firstCurrency, secondCurrency) {
			const marketService = this.simulation.marketService;
			const priceOfFirstCurrencyInSecondCurrency = marketService.getMarginalMarketPriceOfCurrency(secondCurrency,
					firstCurrency);
			const priceOfSecondCurrencyInFirstCurrency = marketService.getMarginalMarketPriceOfCurrency(firstCurrency,
					secondCurrency);
			if (Number.isNaN(priceOfSecondCurrencyInFirstCurrency)) {
				return priceOfFirstCurrencyInSecondCurrency;
			} else if (Number.isNaN(priceOfFirstCurrencyInSecondCurrency)) {
				return NaN;
			}
			return 1.0 / priceOfSecondCurrencyInFirstCurrency;
		}

		buyForeignCurrencyForArbitrage() {
			const simulation = this.simulation;
			const numberOfForeignCurrencies = this.bankAccountsCurrencyTrade.size - 1;
			if (numberOfForeignCurrencies <= 0) {
				return;
			}
			const minArbitrageMargin = simulation.configuration.creditBankConfig.minArbitrageMargin;
			const budgetPerCurrency = this.calculateLocalCurrencyBudgetForCurrencyTrading() / numberOfForeignCurrencies;
			for (const foreignCurrency of this.getCurrencyTradeCurrencies()) {
				if (foreignCurrency === this.primaryCurrency) {
					continue;
				}
				const realPriceOfForeignCurrencyInLocalCurrency = simulation.marketService
					.getMarginalMarketPriceOfCurrency(this.primaryCurrency, foreignCurrency);
				const correctPriceOfForeignCurrencyInLocalCurrency = this
					.calculateCalculatoryPriceOfFirstCurrencyInSecondCurrency(foreignCurrency, this.primaryCurrency);
				if (MathUtil.lesserEqual(budgetPerCurrency, 0)) {
					// no arbitrage, since budget for currency trading is exhausted
				} else if (Number.isNaN(correctPriceOfForeignCurrencyInLocalCurrency)) {
					// no arbitrage, since correct price of foreign currency is unknown
				} else if (MathUtil.lesser(correctPriceOfForeignCurrencyInLocalCurrency / (1.0 + minArbitrageMargin),
						realPriceOfForeignCurrencyInLocalCurrency)) {
					// no arbitrage, since price of foreign currency is too high
				} else {
					/*
					 * if the price of foreign currency denominated in local currency is lower, than
					 * the inverse price of the local currency denominated in foreign currency, then
					 * the foreign currency should be bought low and sold high
					 */
					simulation.marketService.buyCurrency(foreignCurrency, NaN, budgetPerCurrency,
							correctPriceOfForeignCurrencyInLocalCurrency / (1.0 + minArbitrageMargin), this,
							this.getBankAccountCurrencyTradeDelegate(this.primaryCurrency),
							this.getBankAccountCurrencyTradeDelegate(foreignCurrency));
				}
			}
		}

		offerForeignCurrencies() {
			const marketService = this.simulation.marketService;
			for (const currency of this.getCurrencyTradeCurrencies()) {
				const foreignCurrencyBankAccount = this.bankAccountsCurrencyTrade.get(currency);
				if (foreignCurrencyBankAccount.currency !== this.primaryCurrency) {
					// offer foreign currency for local currency
					const localCurrency = this.primaryCurrency;
					const foreignCurrency = foreignCurrencyBankAccount.currency;
					let priceOfForeignCurrencyInLocalCurrency = marketService.getMarginalMarketPriceOfCurrency(
							localCurrency, foreignCurrency);
					if (Number.isNaN(priceOfForeignCurrencyInLocalCurrency)) {
						priceOfForeignCurrencyInLocalCurrency = 1.0;
					}
					marketService.removeAllSellingOffersForCurrency(this, localCurrency, foreignCurrency);
					marketService.placeSellingOfferForCurrency(foreignCurrency, this,
							this.getBankAccountCurrencyTradeDelegate(localCurrency), foreignCurrencyBankAccount.balance,
							priceOfForeignCurrencyInLocalCurrency / 1.001,
							this.getBankAccountCurrencyTradeDelegate(foreignCurrency));
				}
			}
		}

		offerLocalCurrency() {
			const marketService = this.simulation.marketService;
			for (const pricingBehaviour of this.localCurrencyPricingBehaviours.values()) {
				pricingBehaviour.nextPeriod();
			}
			// offer local currency on exchange markets, denominated in foreign currency
			const totalLocalCurrencyBudgetForCurrencyTrading = this.calculateLocalCurrencyBudgetForCurrencyTrading();
			if (MathUtil.lesserEqual(totalLocalCurrencyBudgetForCurrencyTrading, 0)) {
				return;
			}
			const numberOfForeignCurrencies = this.bankAccountsCurrencyTrade.size - 1;
			const partialLocalCurrencyBudgetForCurrency = totalLocalCurrencyBudgetForCurrencyTrading
					/ numberOfForeignCurrencies;
			for (const currency of this.getCurrencyTradeCurrencies()) {
				const foreignCurrencyBankAccount = this.bankAccountsCurrencyTrade.get(currency);
				if (foreignCurrencyBankAccount.currency !== this.primaryCurrency) {
					const localCurrency = this.primaryCurrency;
					const foreignCurrency = foreignCurrencyBankAccount.currency;
					const pricingBehaviour = this.localCurrencyPricingBehaviours.get(foreignCurrency);
					let priceOfLocalCurrencyInForeignCurrency = pricingBehaviour.getCurrentPrice();
					if (Number.isNaN(priceOfLocalCurrencyInForeignCurrency)) {
						priceOfLocalCurrencyInForeignCurrency = marketService.getMarginalMarketPriceOfCurrency(
								foreignCurrency, localCurrency);
					}
					marketService.removeAllSellingOffersForCurrency(this, foreignCurrency, localCurrency);
					marketService.placeSellingOfferForCurrency(localCurrency, this,
							this.getBankAccountCurrencyTradeDelegate(foreignCurrency), partialLocalCurrencyBudgetForCurrency,
							priceOfLocalCurrencyInForeignCurrency, this.getBankAccountCurrencyTradeDelegate(localCurrency));
					pricingBehaviour.registerOfferedAmount(partialLocalCurrencyBudgetForCurrency);
				}
			}
		}

		rebuyLocalCurrency() {
			// buy local currency on exchange markets, denominated in foreign currency
			for (const foreignCurrency of this.getCurrencyTradeCurrencies()) {
				if (foreignCurrency !== this.primaryCurrency) {
					const foreignCurrencyBankAccountBalance = this.getBankAccountCurrencyTradeDelegate(foreignCurrency)
						.getBankAccount().balance;
					if (MathUtil.greater(foreignCurrencyBankAccountBalance, 0.0)) {
						this.simulation.marketService.buyCurrency(this.primaryCurrency, NaN,
								foreignCurrencyBankAccountBalance, NaN, this,
								this.getBankAccountCurrencyTradeDelegate(foreignCurrency),
								this.getBankAccountCurrencyTradeDelegate(this.primaryCurrency));
					}
				}
			}
		}

		issueBalanceSheet() {
			this.assureBankAccountCentralBankTransactions();
			this.assureBankAccountCentralBankMoneyReserves();
			this.assureBankAccountsCurrencyTrade();
			this.assureBankAccountBondLoan();
			const balanceSheet = super.issueBalanceSheet();
			balanceSheet.addBankAccountBalance(this.bankAccountCentralBankTransactions);
			balanceSheet.addBankAccountBalance(this.bankAccountCentralBankMoneyReserves);
			for (const [currency, bankAccount] of this.bankAccountsCurrencyTrade) {
				const price = this.simulation.marketService.getMarginalMarketPriceOfCurrency(this.primaryCurrency,
						currency);
				if (!Number.isNaN(price)) {
					balanceSheet.cashForeignCurrency += bankAccount.balance * price;
				}
			}
			return balanceSheet;
		}

		onBankCloseBankAccount(bankAccount) {
			if (this.bankAccountCentralBankTransactions === bankAccount) {
				this.bankAccountCentralBankTransactions = null;
			}
			if (this.bankAccountCentralBankMoneyReserves === bankAccount) {
				this.bankAccountCentralBankMoneyReserves = null;
			}
			for (const [currency, tradeBankAccount] of Array.from(this.bankAccountsCurrencyTrade)) {
				if (tradeBankAccount === bankAccount) {
					this.bankAccountsCurrencyTrade.delete(currency);
				}
			}
			super.onBankCloseBankAccount(bankAccount);
		}

		onMarketSettlementOfCurrency(commodityCurrency, amount, pricePerUnit, currency) {
			if (commodityCurrency === this.primaryCurrency) {
				this.localCurrencyPricingBehaviours.get(currency).registerSelling(amount, amount * pricePerUnit);
			}
		}

		transferMoney(from, to, amount, subject) {
			this.assureBankAccountCentralBankTransactions();
			if (from !== to) {
				this.simulation.log.bank_onTransfer(from, to, from.currency, amount, subject);
				if (to.managingBank === this && from.managingBank === this) {
					from.withdraw(amount);
					to.deposit(amount);
				} else {
					// transfer to another bank via the central bank
					const centralBank = this.simulation.findCentralBank(from.currency);
					centralBank.transferMoney(from, this.bankAccountCentralBankTransactions, amount, subject);
					centralBank.transferMoney(this.bankAccountCentralBankTransactions, to, amount, subject);
				}
			}
		}
	}

	/**
	 * Port of HouseholdImpl: households offer labour hours and consume goods
	 * according to CES or Cobb-Douglas utility functions
	 */
	class Household extends Agent {
		constructor(simulation) {
			super(simulation);
			this.ageInDays = 0;
			this.bankAccountSavings = null;
			this.continuousDaysWithUtility = 0;
			this.DAYS_WITHOUT_UTILITY_UNTIL_DESTRUCTOR = 0;
			this.daysWithoutUtility = 0;
			this.dividendSinceLastPeriod = 0;
			this.governmentTransfersSinceLastPeriod = 0;
			this.pricingBehaviour = null;
			this.utilityFunction = null;
			this.lastUtility = 0;
			this.bankAccountDividendDelegate = bankAccountDelegate(() => {
				this.assureBankAccountTransactions();
				return this.bankAccountTransactions;
			}, (amount) => {
				this.dividendSinceLastPeriod += amount;
			});
			this.bankAccountGovernmentTransfersDelegate = bankAccountDelegate(() => {
				this.assureBankAccountTransactions();
				return this.bankAccountTransactions;
			}, (amount) => {
				this.governmentTransfersSinceLastPeriod += amount;
			});
		}

		get agentType() {
			return "Household";
		}

		get config() {
			return this.simulation.configuration.householdConfig;
		}

		assureBankAccountSavings() {
			if (this.isDeconstructed) {
				return;
			}
			if (this.bankAccountSavings === null) {
				this.bankAccountSavings = this.getPrimaryBank().openBankAccount(this, this.primaryCurrency, false,
						"savings", TermType.LONG_TERM, MoneyType.DEPOSITS);
			}
		}

		deconstruct() {
			super.deconstruct();
			this.simulation.removeHousehold(this);
		}

		initialize() {
			super.initialize();
			const simulation = this.simulation;
			const days = this.config.daysWithoutUtilityUntilDestructor;
			// int arithmetic as in Java: the result can be negative
			this.DAYS_WITHOUT_UTILITY_UNTIL_DESTRUCTOR = ((days + simulation.random.nextInt()) | 0) % days;
			this.addEvent(() => this.onDailyLife(), EVERY, EVERY, EVERY, simulation.timeSystem.suggestRandomHourType());
			const marketPrice = simulation.marketService.getMarginalMarketPrice(this.primaryCurrency, LABOURHOUR);
			this.pricingBehaviour = new PricingBehaviour(this, LABOURHOUR, this.primaryCurrency, marketPrice);
			this.refreshLabourPower();
		}

		refreshLabourPower() {
			const propertyService = this.simulation.propertyService;
			propertyService.resetGoodTypeAmount(this, LABOURHOUR);
			propertyService.incrementGoodTypeAmount(this, LABOURHOUR, this.config.numberOfLabourHoursPerDay);
		}

		onDailyLife() {
			const simulation = this.simulation;
			// potentially call destructor
			if (this.ageInDays > this.config.lifespanInDays) {
				this.deconstruct();
				return;
			}
			simulation.log.household_AmountSold(this.primaryCurrency, this.pricingBehaviour.getLastSoldAmount());
			// simulation mechanics
			this.ageInDays++;
			this.refreshLabourPower();
			this.pricingBehaviour.nextPeriod();
			this.assureBankAccountTransactions();
			this.assureBankAccountSavings();
			// economic actions
			const budget = this.saveMoney();
			const numberOfLabourHoursToConsume = this.buyOptimalGoodsForBudget(budget);
			const utility = this.consumeGoods(numberOfLabourHoursToConsume);
			this.offerLabourHours();
			this.buyShares();
			this.checkRequiredUtilityPerDay(utility);
			this.checkDeriveNewHousehold();
			this.checkCallDestructor();
		}

		saveMoney() {
			const simulation = this.simulation;
			const income = this.bankAccountTransactions.balance;
			let budget;
			if (this.config.retirementSaving) {
				// Modigliani intertemporal consumption function
				const keyInterestRate = simulation.findCentralBank(this.primaryCurrency).effectiveKeyInterestRate;
				budget = modiglianiConsumptionPlan(income, this.bankAccountSavings.balance, keyInterestRate,
						this.ageInDays, this.config.lifespanInDays, this.config.retirementAgeInDays);
			} else {
				budget = income;
			}
			const moneySumToSave = income - budget;
			const moneySumToConsume = budget;
			simulation.log.household_onIncomeWageDividendTransfersConsumptionSaving(this.primaryCurrency, income,
					moneySumToConsume, moneySumToSave, this.pricingBehaviour.getLastSoldValue(),
					this.dividendSinceLastPeriod, this.governmentTransfersSinceLastPeriod);
			this.dividendSinceLastPeriod = 0;
			this.governmentTransfersSinceLastPeriod = 0;
			if (moneySumToSave > 0.0) {
				// save money for retirement
				this.bankAccountTransactions.managingBank.transferMoney(this.bankAccountTransactions,
						this.bankAccountSavings, moneySumToSave, "retirement savings");
			} else if (moneySumToSave < 0.0) {
				/*
				 * dissavings can happen also when not retired, yet, in case of no income due to
				 * average consumption premise
				 */
				simulation.log.household_onRetired(this);
				this.bankAccountTransactions.managingBank.transferMoney(this.bankAccountSavings,
						this.bankAccountTransactions, -1.0 * moneySumToSave, "retirement dissavings");
			}
			return budget;
		}

		buyOptimalGoodsForBudget(budget) {
			const simulation = this.simulation;
			let numberOfLabourHoursToConsume = 0.0;
			if (MathUtil.greater(budget, 0.0)) {
				const inputTypes = this.utilityFunction.inputTypes;
				const priceFunctions = simulation.marketService.getFixedPriceFunctions(this.primaryCurrency, inputTypes);
				simulation.log.setAgentCurrentlyActive(this);
				const result = this.utilityFunction.calculateOutputMaximizingInputs(priceFunctions, budget,
						simulation.configuration.mathConfig.numberOfIterations,
						simulation.configuration.mathConfig.initializationValue);
				if (result.terminationCause !== null) {
					simulation.log.agent_onCalculateOutputMaximizingInputsIterative(budget, result.budgetSpent,
							result.terminationCause);
				}
				const maxPricePerUnitMultiplier = this.config.maxPricePerUnitMultiplier;
				for (let i = 0; i < inputTypes.length; i++) {
					const goodType = inputTypes[i];
					if (goodType === LABOURHOUR) {
						numberOfLabourHoursToConsume = result.bundle[i];
						continue;
					}
					const amountToBuy = result.bundle[i];
					if (MathUtil.greater(amountToBuy, 0.0)) {
						/*
						 * maxPricePerUnit is significantly important for price equilibrium; also
						 * budget, as in the depth of the markets, prices can rise, leading to
						 * overspending
						 */
						const marginalPrice = priceFunctions[i].fixedPrice;
						simulation.marketService.buyGoodType(goodType, amountToBuy, budget,
								marginalPrice * maxPricePerUnitMultiplier, this, this.bankAccountTransactionsDelegate);
					}
				}
			}
			return numberOfLabourHoursToConsume;
		}

		consumeGoods(numberOfLabourHoursToConsume) {
			const simulation = this.simulation;
			const propertyService = simulation.propertyService;
			const inputTypes = this.utilityFunction.inputTypes;
			const bundle = new Array(inputTypes.length);
			for (let i = 0; i < inputTypes.length; i++) {
				const goodType = inputTypes[i];
				const balance = propertyService.getGoodTypeBalance(this, goodType);
				const amountToConsume = goodType === LABOURHOUR ? Math.min(numberOfLabourHoursToConsume, balance) : balance;
				bundle[i] = amountToConsume;
				propertyService.decrementGoodTypeAmount(this, goodType, amountToConsume);
			}
			const utility = this.utilityFunction.f(bundle);
			this.lastUtility = utility;
			simulation.log.household_onUtility(this, this.bankAccountTransactions.currency, inputTypes, bundle, utility);
			return utility;
		}

		offerLabourHours() {
			const simulation = this.simulation;
			const currency = this.bankAccountTransactions.currency;
			simulation.marketService.removeAllSellingOffersForGoodType(this, currency, LABOURHOUR);
			if (this.ageInDays < this.config.retirementAgeInDays) {
				const amountOfLabourHours = simulation.propertyService.getGoodTypeBalance(this, LABOURHOUR);
				const prices = this.pricingBehaviour.getCurrentPriceArray();
				for (const price of prices) {
					simulation.marketService.placeSellingOfferForGoodType(LABOURHOUR, this,
							this.bankAccountTransactionsDelegate, amountOfLabourHours / prices.length, price);
				}
				this.pricingBehaviour.registerOfferedAmount(amountOfLabourHours);
				simulation.log.household_onOfferResult(this.primaryCurrency, this.pricingBehaviour.getLastOfferedAmount(),
						this.config.numberOfLabourHoursPerDay);
			}
		}

		buyShares() {
			// buy shares / capital -> equity savings
			this.simulation.marketService.buyProperty("Share", 1.0, 0.0, 0.0, this, this.bankAccountTransactionsDelegate);
		}

		checkRequiredUtilityPerDay(utility) {
			if (utility < this.config.requiredUtilityPerDay) {
				this.daysWithoutUtility++;
				this.continuousDaysWithUtility = 0;
			} else {
				if (this.daysWithoutUtility > 0) {
					this.daysWithoutUtility--;
				}
				this.continuousDaysWithUtility++;
			}
		}

		checkDeriveNewHousehold() {
			const newHouseholdFromAgeInDays = this.config.newHouseholdFromAgeInDays;
			if (this.ageInDays >= newHouseholdFromAgeInDays) {
				if ((this.ageInDays - newHouseholdFromAgeInDays) % this.config.newHouseholdEveryXDays === 0) {
					this.simulation.newHousehold(this.primaryCurrency, 0);
				}
			}
		}

		checkCallDestructor() {
			if (this.daysWithoutUtility > this.DAYS_WITHOUT_UTILITY_UNTIL_DESTRUCTOR) {
				if (!this.simulation.timeSystem.isInitializationPhase()) {
					this.deconstruct();
				}
			}
		}

		issueBalanceSheet() {
			this.assureBankAccountSavings();
			const balanceSheet = super.issueBalanceSheet();
			balanceSheet.addBankAccountBalance(this.bankAccountSavings);
			return balanceSheet;
		}

		onBankCloseBankAccount(bankAccount) {
			if (this.bankAccountSavings === bankAccount) {
				this.bankAccountSavings = null;
			}
			super.onBankCloseBankAccount(bankAccount);
		}

		onMarketSettlementOfGoodType(goodType, amount, pricePerUnit, currency) {
			if (goodType === LABOURHOUR) {
				this.pricingBehaviour.registerSelling(amount, amount * pricePerUnit);
			}
		}

		onPropertyTransferred(property, oldOwner, newOwner) {
			if (newOwner === this && property instanceof Share) {
				property.dividendBankAccountDelegate = this.bankAccountDividendDelegate;
				/*
				 * sell shares that are denominated in an incorrect currency
				 */
				if (this.primaryCurrency !== property.issuer.primaryCurrency) {
					this.simulation.marketService.placeSellingOfferForProperty(property, this,
							this.bankAccountTransactionsDelegate, 0.0);
				}
			}
		}
	}

	/**
	 * Port of ModiglianiIntertemporalConsumptionFunction (consumption of the
	 * current period)
	 */
	function modiglianiConsumptionPlan(averageIncomePerPeriod, currentAssets, keyInterestRate, ageInDays,
			lifeSpanInDays, retirementAgeInDays) {
		const averageRemainingLifeDays = lifeSpanInDays - ageInDays;
		const remainingDaysUntilRetirement = Math.max(retirementAgeInDays - ageInDays, 0);
		if (averageRemainingLifeDays > 0) {
			const lifeConsumption = currentAssets + averageIncomePerPeriod * remainingDaysUntilRetirement;
			return lifeConsumption / averageRemainingLifeDays;
		}
		return averageIncomePerPeriod + currentAssets;
	}

	/**
	 * Port of FactoryImpl: factories produce goods according to the input-output
	 * model
	 */
	class Factory extends JointStockCompany {
		constructor(simulation) {
			super(simulation);
			this.budgetingBehaviour = null;
			this.pricingBehaviour = null;
			this.producedGoodType = null;
			this.productionFunction = null;
		}

		get agentType() {
			return "Factory";
		}

		deconstruct() {
			super.deconstruct();
			this.simulation.removeFactory(this);
		}

		initialize() {
			super.initialize();
			const simulation = this.simulation;
			this.addEvent(() => this.onProduction(), EVERY, EVERY, EVERY, simulation.timeSystem.suggestRandomHourType());
			const marketPrice = simulation.marketService.getMarginalMarketPrice(this.primaryCurrency,
					this.producedGoodType);
			this.pricingBehaviour = new PricingBehaviour(this, this.producedGoodType, this.primaryCurrency, marketPrice);
			this.budgetingBehaviour = new BudgetingBehaviour(this);
		}

		onProduction() {
			const simulation = this.simulation;
			this.assureBankAccountTransactions();
			simulation.log.factory_AmountSold(this.primaryCurrency, this.producedGoodType,
					this.pricingBehaviour.getLastSoldAmount());
			// simulation mechanics
			this.pricingBehaviour.nextPeriod();
			// economic actions
			this.transferBankAccountBalanceToDividendBankAccount(this.bankAccountTransactions);
			// has to happen before offering good on market; otherwise more than owned is offered
			this.capitalDepreciation();
			const budget = this.budgetingBehaviour.calculateTransmissionBasedBudgetForPeriod(
					this.bankAccountTransactions.currency, this.bankAccountTransactions.balance, this.referenceCredit);
			this.buyOptimalProductionFactorsForBudget(budget);
			const producedOutput = this.produce();
			this.offerProducedGoodType(producedOutput);
		}

		buyOptimalProductionFactorsForBudget(budget) {
			const simulation = this.simulation;
			if (!MathUtil.greater(budget, 0.0)) {
				return;
			}
			const inputTypes = this.productionFunction.inputTypes;
			const priceFunctions = simulation.marketService.getMarketPriceFunctions(this.primaryCurrency, inputTypes);
			// calculate optimal production plan
			const priceOfProducedGoodType = simulation.marketService.getMarginalMarketPrice(this.primaryCurrency,
					this.producedGoodType);
			const capitalBalances = simulation.propertyService.getCapitalBalances(this);
			const capital = inputTypes.map((goodType) => MathUtil.nullSafeValue(capitalBalances.get(goodType)));
			simulation.log.setAgentCurrentlyActive(this);
			const result = this.productionFunction.calculateProfitMaximizingProductionFactors(priceOfProducedGoodType,
					priceFunctions, capital, budget, NaN, simulation.configuration.factoryConfig.margin,
					simulation.configuration.mathConfig.numberOfIterations,
					simulation.configuration.mathConfig.initializationValue);
			simulation.log.factory_onCalculateProfitMaximizingProductionFactorsIterative(budget, result.budgetSpent,
					result.terminationCause);
			/*
			 * the optimal production plan includes capital goods. Only surplus capital goods
			 * should be bought!
			 */
			for (let i = 0; i < inputTypes.length; i++) {
				const amountToBuy = Math.max(result.bundle[i] - capital[i], 0.0);
				if (MathUtil.greater(amountToBuy, 0.0)) {
					simulation.marketService.buyGoodType(inputTypes[i], amountToBuy, NaN, NaN, this,
							this.bankAccountTransactionsDelegate);
				}
			}
			const creditBudgetCapacity = this.budgetingBehaviour.getCreditBasedBudgetCapacity();
			const creditUtilization = -1.0 * this.bankAccountTransactions.balance;
			simulation.log.agent_CreditUtilization(this, creditUtilization, creditBudgetCapacity);
		}

		capitalDepreciation() {
			const simulation = this.simulation;
			const depreciationRatio = simulation.configuration.factoryConfig.capitalDepreciationRatioPerPeriod;
			for (const [capitalGoodType, amount] of simulation.propertyService.getCapitalBalances(this)) {
				const depreciation = depreciationRatio * amount;
				if (depreciation > 0) {
					simulation.propertyService.decrementGoodTypeAmount(this, capitalGoodType, depreciation);
					simulation.log.factory_onCapitalDepreciation(this, capitalGoodType, depreciation);
				}
			}
		}

		produce() {
			const simulation = this.simulation;
			const propertyService = simulation.propertyService;
			const inputTypes = this.productionFunction.inputTypes;
			const productionFactorsOwned = inputTypes.map((goodType) => propertyService.getGoodTypeBalance(this, goodType));
			const producedOutput = this.productionFunction.f(productionFactorsOwned);
			propertyService.incrementGoodTypeAmount(this, this.producedGoodType, producedOutput);
			simulation.log.factory_onProduction(this, this.primaryCurrency, this.producedGoodType, producedOutput,
					inputTypes, productionFactorsOwned);
			// deregister production factors from property register
			for (let i = 0; i < inputTypes.length; i++) {
				if (!inputTypes[i].durable) {
					propertyService.decrementGoodTypeAmount(this, inputTypes[i], productionFactorsOwned[i]);
				}
			}
			return producedOutput;
		}

		offerProducedGoodType() {
			const simulation = this.simulation;
			simulation.marketService.removeAllSellingOffersForGoodType(this, this.primaryCurrency, this.producedGoodType);
			const amountInInventory = simulation.propertyService.getGoodTypeBalance(this, this.producedGoodType);
			const prices = this.pricingBehaviour.getCurrentPriceArray();
			for (const price of prices) {
				simulation.marketService.placeSellingOfferForGoodType(this.producedGoodType, this,
						this.bankAccountTransactionsDelegate, amountInInventory / prices.length, price);
			}
			this.pricingBehaviour.registerOfferedAmount(amountInInventory);
			simulation.log.factory_onOfferGoodType(this.primaryCurrency, this.producedGoodType, amountInInventory,
					amountInInventory);
		}

		onMarketSettlementOfGoodType(goodType, amount, pricePerUnit, currency) {
			this.assureBankAccountTransactions();
			if (this.producedGoodType === goodType) {
				this.pricingBehaviour.registerSelling(amount, amount * pricePerUnit);
			}
		}

		toString() {
			return super.toString() + " " + this.producedGoodType.name;
		}
	}

	/**
	 * Port of TraderImpl: traders import goods from foreign markets for arbitrage
	 */
	class Trader extends JointStockCompany {
		constructor(simulation) {
			super(simulation);
			this.bankAccountsGoodTrade = new Map();
			this.bankAccountsGoodTradeDelegate = new Map();
			this.budgetingBehaviour = null;
			this.excludedGoodTypes = new Set();
		}

		get agentType() {
			return "Trader";
		}

		assureBankAccountsGoodTrade() {
			if (this.isDeconstructed) {
				return;
			}
			for (const currency of Currency.values()) {
				if (currency !== this.primaryCurrency && !this.bankAccountsGoodTrade.has(currency)) {
					const foreignCurrencyCreditBank = this.simulation.findRandomCreditBank(currency);
					this.bankAccountsGoodTrade.set(currency, foreignCurrencyCreditBank.openBankAccount(this, currency, true,
							"foreign currency", TermType.SHORT_TERM, MoneyType.DEPOSITS));
				}
			}
		}

		deconstruct() {
			super.deconstruct();
			this.simulation.removeTrader(this);
		}

		getBankAccountGoodsTradeDelegate(currency) {
			return this.bankAccountsGoodTradeDelegate.get(currency);
		}

		initialize() {
			super.initialize();
			const simulation = this.simulation;
			this.addEvent(() => this.onArbitrageTrading(), EVERY, EVERY, EVERY,
					simulation.timeSystem.suggestRandomHourType());
			for (const currency of Currency.values()) {
				this.bankAccountsGoodTradeDelegate.set(currency, bankAccountDelegate(() => {
					this.assureBankAccountsGoodTrade();
					return this.bankAccountsGoodTrade.get(currency);
				}));
			}
			this.budgetingBehaviour = new BudgetingBehaviour(this);
		}

		onArbitrageTrading() {
			this.assureBankAccountTransactions();
			this.assureBankAccountsGoodTrade();
			this.transferBankAccountBalanceToDividendBankAccount(this.bankAccountTransactions);
			this.buyGoodsForArbitrage();
			this.offerGoods();
		}

		buyGoodsForArbitrage() {
			const simulation = this.simulation;
			const marketService = simulation.marketService;
			const numberOfForeignCurrencies = this.bankAccountsGoodTrade.size;
			const budget = this.budgetingBehaviour.calculateTransmissionBasedBudgetForPeriod(
					this.bankAccountTransactions.currency, this.bankAccountTransactions.balance, this.referenceCredit);
			const budgetPerForeignCurrencyInLocalCurrency = budget / numberOfForeignCurrencies;
			if (!MathUtil.greater(budgetPerForeignCurrencyInLocalCurrency, 0.0)) {
				return;
			}
			const arbitrageMargin = simulation.configuration.traderConfig.arbitrageMargin;
			for (const foreignCurrency of Currency.values()) {
				if (foreignCurrency === this.primaryCurrency || !this.bankAccountsGoodTrade.has(foreignCurrency)) {
					continue;
				}
				const localCurrency = this.primaryCurrency;
				// budget (local currency) for this good type, that can be spent for buying foreign currency
				const budgetPerGoodTypeAndForeignCurrencyInLocalCurrency = budgetPerForeignCurrencyInLocalCurrency
						/ (GoodType.count - this.excludedGoodTypes.size);
				for (const goodType of GoodType.values()) {
					if (this.excludedGoodTypes.has(goodType)) {
						continue;
					}
					const priceOfGoodTypeInLocalCurrency = marketService.getMarginalMarketPrice(localCurrency, goodType);
					const priceOfGoodTypeInForeignCurrency = marketService.getMarginalMarketPrice(foreignCurrency,
							goodType);
					const priceOfForeignCurrencyInLocalCurrency = marketService.getMarginalMarketPriceOfCurrency(
							localCurrency, foreignCurrency);
					if (Number.isNaN(priceOfGoodTypeInForeignCurrency) || Number.isNaN(priceOfGoodTypeInLocalCurrency)
							|| Number.isNaN(priceOfForeignCurrencyInLocalCurrency)) {
						continue;
					}
					const importPriceOfGoodTypeInLocalCurrency = priceOfGoodTypeInForeignCurrency
							* priceOfForeignCurrencyInLocalCurrency;
					if (MathUtil.greater(priceOfGoodTypeInLocalCurrency / (1.0 + arbitrageMargin),
							importPriceOfGoodTypeInLocalCurrency)) {
						// buy foreign currency with local currency
						marketService.buyCurrency(foreignCurrency, NaN, budgetPerGoodTypeAndForeignCurrencyInLocalCurrency,
								priceOfForeignCurrencyInLocalCurrency, this, this.bankAccountTransactionsDelegate,
								this.getBankAccountGoodsTradeDelegate(foreignCurrency));
						// buy goods of good type with foreign currency
						marketService.buyGoodType(goodType, NaN,
								this.getBankAccountGoodsTradeDelegate(foreignCurrency).getBankAccount().balance,
								priceOfGoodTypeInForeignCurrency, this, this.getBankAccountGoodsTradeDelegate(foreignCurrency));
					}
				}
			}
		}

		offerGoods() {
			// for each good type offer owned goods at market price -> price taker
			const simulation = this.simulation;
			for (const goodType of GoodType.values()) {
				if (!this.excludedGoodTypes.has(goodType)) {
					simulation.marketService.removeAllSellingOffersForGoodType(this, this.primaryCurrency, goodType);
					const amount = simulation.propertyService.getGoodTypeBalance(this, goodType);
					const marketPrice = simulation.marketService.getMarginalMarketPrice(this.primaryCurrency, goodType);
					simulation.marketService.placeSellingOfferForGoodType(goodType, this,
							this.bankAccountTransactionsDelegate, amount, marketPrice);
				}
			}
		}

		issueBalanceSheet() {
			this.assureBankAccountsGoodTrade();
			const balanceSheet = super.issueBalanceSheet();
			for (const [currency, bankAccount] of this.bankAccountsGoodTrade) {
				const price = this.simulation.marketService.getMarginalMarketPriceOfCurrency(this.primaryCurrency,
						currency);
				if (!Number.isNaN(price)) {
					balanceSheet.cashForeignCurrency += bankAccount.balance * price;
				}
			}
			return balanceSheet;
		}

		onBankCloseBankAccount(bankAccount) {
			for (const [currency, tradeBankAccount] of Array.from(this.bankAccountsGoodTrade)) {
				if (tradeBankAccount === bankAccount) {
					this.bankAccountsGoodTrade.delete(currency);
				}
			}
			super.onBankCloseBankAccount(bankAccount);
		}

		onMarketSettlementOfGoodType() {
			this.assureBankAccountTransactions();
		}
	}

	/**
	 * Port of StateImpl: states emit bonds, which are bought by credit banks for
	 * customer savings deposits, and transfer their budget to households
	 */
	class State extends Agent {
		constructor(simulation) {
			super(simulation);
			this.bankAccountCouponLoans = null;
			this.bankAccountCouponLoansDelegate = bankAccountDelegate(() => {
				this.assureBankAccountCouponLoans();
				return this.bankAccountCouponLoans;
			});
			this.pricingBehaviour = null;
		}

		get agentType() {
			return "State";
		}

		assureBankAccountCouponLoans() {
			if (this.isDeconstructed) {
				return;
			}
			if (this.bankAccountCouponLoans === null) {
				this.bankAccountCouponLoans = this.getPrimaryBank().openBankAccount(this, this.primaryCurrency, true,
						"loans", TermType.LONG_TERM, MoneyType.DEPOSITS);
			}
		}

		deconstruct() {
			super.deconstruct();
			this.simulation.states.delete(this.primaryCurrency);
		}

		initialize() {
			super.initialize();
			const simulation = this.simulation;
			/*
			 * has to happen every hour, so that not all money is spent on one distinct hour
			 * a day! else this would lead to significant distortions on markets, as the
			 * savings of the whole economy flow through the state via state bonds.
			 */
			this.addEventEvery(() => this.transferBudgetToHouseholds(), EVERY);
			const initialInterestRate = simulation.findCentralBank(this.primaryCurrency).effectiveKeyInterestRate + 0.02;
			this.pricingBehaviour = new PricingBehaviour(this, "FixedRateBond", this.primaryCurrency, initialInterestRate);
		}

		transferBudgetToHouseholds() {
			this.assureBankAccountTransactions();
			const budget = this.bankAccountTransactions.balance;
			if (MathUtil.greater(budget, 0.0)) {
				const households = this.simulation.householdsByCurrency[this.primaryCurrency.ordinal];
				if (households.length > 0) {
					const budgetPerHousehold = budget / households.length;
					for (const household of Array.from(households.items)) {
						const householdBankAccount = household.bankAccountGovernmentTransfersDelegate.getBankAccount();
						this.bankAccountTransactions.managingBank.transferMoney(this.bankAccountTransactions,
								householdBankAccount, budgetPerHousehold, "government transfer");
						household.bankAccountGovernmentTransfersDelegate.onTransfer(budgetPerHousehold);
					}
				}
			}
		}

		issueBalanceSheet() {
			const balanceSheet = super.issueBalanceSheet();
			balanceSheet.addBankAccountBalance(this.bankAccountCouponLoans);
			return balanceSheet;
		}

		obtainBond(faceValue, buyer, buyerBankAccountDelegate) {
			const simulation = this.simulation;
			this.assureBankAccountCouponLoans();
			const centralBank = simulation.findCentralBank(this.primaryCurrency);
			const coupon = centralBank.effectiveKeyInterestRate + simulation.configuration.stateConfig.bondMargin;
			const fixedRateBond = simulation.newFixedRateBond(this, this, this.primaryCurrency,
					this.bankAccountTransactionsDelegate, this.bankAccountCouponLoansDelegate, faceValue, coupon);
			const buyerBankAccount = buyerBankAccountDelegate.getBankAccount();
			buyerBankAccount.managingBank.transferMoney(buyerBankAccount, this.bankAccountTransactions, faceValue,
					"payment for bond");
			simulation.propertyService.transferProperty(fixedRateBond, this, buyer);
			return fixedRateBond;
		}

		onBankCloseBankAccount(bankAccount) {
			if (this.bankAccountCouponLoans === bankAccount) {
				this.bankAccountCouponLoans = null;
			}
			super.onBankCloseBankAccount(bankAccount);
		}

		onMarketSettlementOfProperty(property, totalPrice) {
			if (property instanceof FixedRateBond) {
				this.pricingBehaviour.registerSelling(property.faceValue, totalPrice);
			}
		}
	}

	/*
	 * simulation context
	 */

	/**
	 * Simulation context, replacing the ApplicationContext singleton of the Java
	 * version: holds configuration, services, DAOs and factories.
	 */
	class Simulation {
		constructor(configuration, log, options) {
			this.configuration = configuration;
			this.log = log;
			this.random = new JavaRandom(options && options.seed !== undefined ? options.seed : 100);
			this.sequenceNumber = 0;
			this.timeSystem = new TimeSystem(this, 2001);
			this.marketService = new MarketService(this);
			this.propertyService = new PropertyService(this);
			this.bankAccountDAO = new BankAccountDAO();
			this.hardCashService = new HardCashService();
			this.inputOutputModel = INPUT_OUTPUT_MODELS[configuration.inputOutputModelConfig.inputOutputModel];
			if (!this.inputOutputModel) {
				throw new Error("inputOutputModel not set");
			}
			this.households = new IndexedList();
			this.householdsByCurrency = Currency.values().map(() => new IndexedList());
			this.creditBanksByCurrency = Currency.values().map(() => []);
			this.factoriesByCurrency = Currency.values().map(() => new IndexedList());
			this.tradersByCurrency = Currency.values().map(() => new IndexedList());
			this.centralBanks = new Map();
			this.states = new Map();
			log.attach(this);
		}

		nextId() {
			return ++this.sequenceNumber;
		}

		/*
		 * agent service
		 */

		findCentralBank(currency) {
			const centralBank = this.centralBanks.get(currency);
			return centralBank || this.newCentralBank(currency);
		}

		findState(currency) {
			const state = this.states.get(currency);
			return state || this.newState(currency);
		}

		findRandomCreditBank(currency) {
			const creditBanks = this.creditBanksByCurrency[currency.ordinal];
			if (creditBanks.length > 0) {
				return creditBanks[this.random.nextInt(creditBanks.length)];
			}
			return null;
		}

		/*
		 * factories
		 */

		newCentralBank(currency) {
			const centralBank = new CentralBank(this);
			centralBank.id = this.nextId();
			centralBank.primaryCurrency = currency;
			this.centralBanks.set(currency, centralBank);
			centralBank.initialize();
			return centralBank;
		}

		newState(currency) {
			const state = new State(this);
			state.id = this.nextId();
			state.primaryCurrency = currency;
			this.states.set(currency, state);
			state.initialize();
			return state;
		}

		newCreditBank(currency) {
			const creditBank = new CreditBank(this);
			creditBank.id = this.nextId();
			creditBank.primaryCurrency = currency;
			this.creditBanksByCurrency[currency.ordinal].push(creditBank);
			creditBank.initialize();
			return creditBank;
		}

		removeCreditBank(creditBank) {
			const creditBanks = this.creditBanksByCurrency[creditBank.primaryCurrency.ordinal];
			const index = creditBanks.indexOf(creditBank);
			if (index !== -1) {
				creditBanks.splice(index, 1);
			}
		}

		newFactory(goodType, currency) {
			const factory = new Factory(this);
			factory.id = this.nextId();
			factory.producedGoodType = goodType;
			factory.primaryCurrency = currency;
			factory.referenceCredit = this.configuration.factoryConfig.referenceCredit;
			factory.productionFunction = this.inputOutputModel.getProductionFunction(goodType);
			this.factoriesByCurrency[currency.ordinal].add(factory);
			factory.initialize();
			return factory;
		}

		removeFactory(factory) {
			this.factoriesByCurrency[factory.primaryCurrency.ordinal].remove(factory);
		}

		newTrader(currency) {
			const trader = new Trader(this);
			trader.id = this.nextId();
			trader.primaryCurrency = currency;
			trader.referenceCredit = this.configuration.traderConfig.referenceCredit;
			trader.excludedGoodTypes.add(LABOURHOUR);
			for (const goodType of GoodType.values()) {
				if (goodType.sector === CE.Sector.TERTIARY) {
					trader.excludedGoodTypes.add(goodType);
				}
			}
			this.tradersByCurrency[currency.ordinal].add(trader);
			trader.initialize();
			return trader;
		}

		removeTrader(trader) {
			this.tradersByCurrency[trader.primaryCurrency.ordinal].remove(trader);
		}

		newHousehold(currency, ageInDays) {
			const household = new Household(this);
			household.id = this.nextId();
			household.ageInDays = ageInDays;
			household.primaryCurrency = currency;
			household.utilityFunction = this.inputOutputModel.getUtilityFunctionOfHousehold();
			this.households.add(household);
			this.householdsByCurrency[currency.ordinal].add(household);
			household.initialize();
			return household;
		}

		removeHousehold(household) {
			this.households.remove(household);
			this.householdsByCurrency[household.primaryCurrency.ordinal].remove(household);
		}

		newFixedRateBond(owner, issuer, currency, faceValueFromBankAccountDelegate, couponFromBankAccountDelegate,
				faceValue, coupon) {
			const fixedRateBond = new FixedRateBond(this, this.nextId());
			fixedRateBond.owner = owner;
			fixedRateBond.issuer = issuer;
			fixedRateBond.faceValueFromBankAccountDelegate = faceValueFromBankAccountDelegate;
			fixedRateBond.couponFromBankAccountDelegate = couponFromBankAccountDelegate;
			fixedRateBond.faceValue = faceValue;
			fixedRateBond.coupon = coupon;
			fixedRateBond.issuedInCurrency = currency;
			fixedRateBond.initialize();
			this.propertyService.dao.save(fixedRateBond);
			return fixedRateBond;
		}

		/**
		 * Port of AgentImplFactoryImpl.constructAgentsFromConfiguration
		 */
		constructAgentsFromConfiguration() {
			const config = this.configuration;
			for (const currency of Currency.values()) {
				if (config.stateConfig.number[currency.name] === 1) {
					this.findState(currency);
				}
			}
			for (const currency of Currency.values()) {
				if (config.centralBankConfig.number[currency.name] === 1) {
					this.findCentralBank(currency);
				}
			}
			for (const currency of Currency.values()) {
				for (let i = 0; i < config.creditBankConfig.number[currency.name]; i++) {
					this.newCreditBank(currency);
				}
			}
			for (const currency of Currency.values()) {
				for (const goodType of GoodType.values()) {
					if (goodType !== LABOURHOUR) {
						for (let i = 0; i < config.factoryConfig.number[currency.name][goodType.name]; i++) {
							this.newFactory(goodType, currency);
						}
					}
				}
			}
			for (const currency of Currency.values()) {
				for (let i = 0; i < config.traderConfig.number[currency.name]; i++) {
					this.newTrader(currency);
				}
			}
			const householdAgeLimit = Math.trunc(config.householdConfig.lifespanInDays / 2);
			for (const currency of Currency.values()) {
				for (let i = 0; i < config.householdConfig.number[currency.name]; i++) {
					this.newHousehold(currency, this.random.nextInt(householdAgeLimit));
				}
			}
		}

		nextHour() {
			this.timeSystem.nextHour();
		}

		/*
		 * accessors for the dashboard
		 */

		countAgents(currency) {
			const c = currency.ordinal;
			return {
				Household: this.householdsByCurrency[c].length,
				Factory: this.factoriesByCurrency[c].length,
				Trader: this.tradersByCurrency[c].length,
				CreditBank: this.creditBanksByCurrency[c].length,
				CentralBank: this.centralBanks.has(currency) ? 1 : 0,
				State: this.states.has(currency) ? 1 : 0,
			};
		}
	}

	Object.assign(CE, {
		Simulation,
		TimeSystem,
		MarketService,
		MarketOrder,
		PropertyService,
		PricingBehaviour,
		BudgetingBehaviour,
		BalanceSheetDTO,
		Agent,
		Household,
		Factory,
		Trader,
		State,
		CreditBank,
		CentralBank,
		Share,
		FixedRateBond,
		INPUT_OUTPUT_MODELS,
		PricingBehaviourNewPriceDecisionCause,
	});
})(typeof self !== "undefined" ? self : globalThis);
