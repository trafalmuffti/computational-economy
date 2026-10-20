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
 * Dependency-free canvas line chart for daily time series, replacing the
 * JFreeChart panels of the Swing dashboard: legend with line keys, direct end
 * labels for up to four series, crosshair tooltip and a table view.
 */
(function (root) {
	"use strict";

	const CE = (root.CompEcon = root.CompEcon || {});
	const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

	function cssVar(name) {
		return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	}

	function formatNumber(value, kind) {
		if (!Number.isFinite(value)) {
			return "–";
		}
		if (kind === "percent") {
			return (value * 100).toFixed(2) + " %";
		}
		if (kind === "ratio") {
			return value.toFixed(3);
		}
		const abs = Math.abs(value);
		if (abs >= 1e9) {
			return (value / 1e9).toFixed(2) + " B";
		}
		if (abs >= 1e6) {
			return (value / 1e6).toFixed(2) + " M";
		}
		if (abs >= 1e4) {
			return (value / 1e3).toFixed(1) + " k";
		}
		if (abs >= 100) {
			return value.toFixed(0);
		}
		if (abs >= 1) {
			return value.toFixed(2);
		}
		return value.toFixed(3);
	}

	function formatDate(time) {
		const date = new Date(time);
		return date.getUTCDate() + " " + MONTHS[date.getUTCMonth()] + " " + date.getUTCFullYear();
	}

	function niceStep(range, targetTicks) {
		const rough = range / Math.max(1, targetTicks);
		const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
		const residual = rough / magnitude;
		const nice = residual >= 5 ? 10 : residual >= 2 ? 5 : residual >= 1 ? 2 : 1;
		return nice * magnitude;
	}

	class LineChart {
		/**
		 * @param card    container element with .chart-legend, .chart-plot and
		 *                .chart-table children
		 * @param options {series: [{label, color}], format, zeroBased}
		 */
		constructor(card, options) {
			this.card = card;
			this.options = options;
			this.legend = card.querySelector(".chart-legend");
			this.plot = card.querySelector(".chart-plot");
			this.tableContainer = card.querySelector(".chart-table");
			this.canvas = document.createElement("canvas");
			this.canvas.setAttribute("role", "img");
			this.plot.appendChild(this.canvas);
			this.tooltip = document.createElement("div");
			this.tooltip.className = "chart-tooltip";
			this.tooltip.hidden = true;
			this.plot.appendChild(this.tooltip);
			this.emptyNote = document.createElement("div");
			this.emptyNote.className = "chart-empty";
			this.emptyNote.textContent = "Waiting for the first simulated days";
			this.plot.appendChild(this.emptyNote);
			this.times = [];
			this.values = [];
			this.hoverIndex = -1;
			this.layout = null;
			this.setSeries(options.series);
			this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
			this.canvas.addEventListener("pointerleave", () => this.hideTooltip());
			new ResizeObserver(() => this.draw()).observe(this.plot);
			const tableButton = card.querySelector(".chart-table-toggle");
			if (tableButton) {
				tableButton.addEventListener("click", () => {
					const show = this.tableContainer.hidden;
					this.tableContainer.hidden = !show;
					tableButton.setAttribute("aria-expanded", String(show));
					tableButton.textContent = show ? "Hide table" : "Table";
					this.renderTable();
				});
			}
		}

		setSeries(series) {
			this.series = series;
			this.legend.textContent = "";
			if (series.length < 2) {
				return;
			}
			for (const s of series) {
				const item = document.createElement("span");
				item.className = "legend-item";
				const key = document.createElement("span");
				key.className = "legend-key";
				key.style.background = "var(" + s.color + ")";
				const label = document.createElement("span");
				label.textContent = s.label;
				item.append(key, label);
				this.legend.appendChild(item);
			}
		}

		/**
		 * @param times  array of timestamps (UTC ms)
		 * @param values array (one per series) of arrays aligned with times
		 */
		setData(times, values) {
			this.times = times;
			this.values = values;
			this.draw();
			if (!this.tableContainer.hidden) {
				this.renderTable();
			}
			if (this.hoverIndex >= 0) {
				this.showTooltip(Math.min(this.hoverIndex, times.length - 1));
			}
		}

		draw() {
			const width = this.plot.clientWidth;
			const height = this.plot.clientHeight;
			if (width === 0 || height === 0) {
				return;
			}
			const dpr = window.devicePixelRatio || 1;
			if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
				this.canvas.width = Math.round(width * dpr);
				this.canvas.height = Math.round(height * dpr);
				this.canvas.style.width = width + "px";
				this.canvas.style.height = height + "px";
			}
			const ctx = this.canvas.getContext("2d");
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, width, height);

			const n = this.times.length;
			this.emptyNote.hidden = n > 1;
			if (n < 2) {
				this.layout = null;
				return;
			}

			// value range
			let min = Infinity;
			let max = -Infinity;
			for (const series of this.values) {
				for (let i = 0; i < n; i++) {
					const v = series[i];
					if (Number.isFinite(v)) {
						if (v < min) min = v;
						if (v > max) max = v;
					}
				}
			}
			if (!Number.isFinite(min)) {
				min = 0;
				max = 1;
			}
			if (this.options.zeroBased !== false && min > 0) {
				min = 0;
			}
			if (max === min) {
				max = min + (Math.abs(min) || 1);
			}
			const step = niceStep(max - min, 4);
			min = Math.floor(min / step) * step;
			max = Math.ceil(max / step) * step;

			const directLabels = this.series.length <= 4;
			ctx.font = "11px " + cssVar("--font-data");
			let labelWidth = 0;
			if (directLabels) {
				for (const s of this.series) {
					labelWidth = Math.max(labelWidth, ctx.measureText(s.short || s.label).width);
				}
			}
			const yTickLabels = [];
			for (let v = min; v <= max + step / 2; v += step) {
				yTickLabels.push(v);
			}
			let yLabelWidth = 0;
			for (const v of yTickLabels) {
				yLabelWidth = Math.max(yLabelWidth, ctx.measureText(formatNumber(v, this.options.format)).width);
			}
			const left = Math.ceil(yLabelWidth) + 10;
			const right = directLabels ? Math.min(Math.ceil(labelWidth) + 14, width * 0.3) : 8;
			const top = 8;
			const bottom = 22;
			const plotWidth = width - left - right;
			const plotHeight = height - top - bottom;
			const t0 = this.times[0];
			const t1 = this.times[n - 1];
			const x = (i) => left + ((this.times[i] - t0) / (t1 - t0)) * plotWidth;
			const y = (v) => top + (1 - (v - min) / (max - min)) * plotHeight;
			this.layout = { left, right, top, plotWidth, plotHeight, x, y, n };

			// grid and y axis
			ctx.strokeStyle = cssVar("--grid");
			ctx.fillStyle = cssVar("--ink-3");
			ctx.lineWidth = 1;
			ctx.textAlign = "right";
			ctx.textBaseline = "middle";
			for (const v of yTickLabels) {
				const py = Math.round(y(v)) + 0.5;
				ctx.beginPath();
				ctx.moveTo(left, py);
				ctx.lineTo(left + plotWidth, py);
				ctx.stroke();
				ctx.fillText(formatNumber(v, this.options.format), left - 6, py);
			}

			// x axis: month or year ticks
			ctx.textAlign = "center";
			ctx.textBaseline = "top";
			const spanDays = (t1 - t0) / 86400000;
			const monthStep = spanDays > 1500 ? 12 : spanDays > 700 ? 6 : spanDays > 300 ? 3 : spanDays > 120 ? 2 : 1;
			const first = new Date(t0);
			let tickDate = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1);
			let lastLabelX = -Infinity;
			while (tickDate <= t1) {
				const d = new Date(tickDate);
				if (d.getUTCMonth() % monthStep === 0) {
					const px = left + ((tickDate - t0) / (t1 - t0)) * plotWidth;
					const label = d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : MONTHS[d.getUTCMonth()];
					if (px - lastLabelX > 36) {
						ctx.fillText(label, px, top + plotHeight + 6);
						lastLabelX = px;
					}
					ctx.beginPath();
					ctx.moveTo(Math.round(px) + 0.5, top + plotHeight);
					ctx.lineTo(Math.round(px) + 0.5, top + plotHeight + 3);
					ctx.stroke();
				}
				tickDate = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
			}

			// baseline
			ctx.strokeStyle = cssVar("--axis");
			ctx.beginPath();
			ctx.moveTo(left, Math.round(top + plotHeight) + 0.5);
			ctx.lineTo(left + plotWidth, Math.round(top + plotHeight) + 0.5);
			ctx.stroke();

			// lines
			ctx.lineWidth = 2;
			ctx.lineJoin = "round";
			ctx.lineCap = "round";
			const ends = [];
			this.series.forEach((s, k) => {
				const values = this.values[k] || [];
				ctx.strokeStyle = cssVar(s.color);
				ctx.beginPath();
				let penDown = false;
				let lastIndex = -1;
				for (let i = 0; i < n; i++) {
					const v = values[i];
					if (!Number.isFinite(v)) {
						penDown = false;
						continue;
					}
					if (penDown) {
						ctx.lineTo(x(i), y(v));
					} else {
						ctx.moveTo(x(i), y(v));
						penDown = true;
					}
					lastIndex = i;
				}
				ctx.stroke();
				if (lastIndex >= 0) {
					ends.push({ s, py: y(values[lastIndex]), px: x(lastIndex) });
				}
			});

			// end points and direct labels, spread to avoid collisions
			for (const end of ends) {
				ctx.fillStyle = cssVar(end.s.color);
				ctx.strokeStyle = cssVar("--surface");
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.arc(end.px, end.py, 3.5, 0, Math.PI * 2);
				ctx.fill();
				ctx.stroke();
			}
			if (directLabels && ends.length > 0) {
				ends.sort((a, b) => a.py - b.py);
				const gap = 13;
				for (let i = 1; i < ends.length; i++) {
					ends[i].ly = Math.max(ends[i].py, (ends[i - 1].ly ?? ends[i - 1].py) + gap);
				}
				ends[0].ly = ends[0].py;
				const overflow = (ends[ends.length - 1].ly ?? 0) - (top + plotHeight);
				if (overflow > 0) {
					for (const end of ends) {
						end.ly = (end.ly ?? end.py) - overflow;
					}
				}
				ctx.textAlign = "left";
				ctx.textBaseline = "middle";
				ctx.fillStyle = cssVar("--ink-2");
				for (const end of ends) {
					ctx.fillText(end.s.short || end.s.label, left + plotWidth + 8, Math.max(top + 4, end.ly ?? end.py));
				}
			}

			// crosshair
			if (this.hoverIndex >= 0 && this.hoverIndex < n) {
				const px = Math.round(x(this.hoverIndex)) + 0.5;
				ctx.strokeStyle = cssVar("--ink-3");
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(px, top);
				ctx.lineTo(px, top + plotHeight);
				ctx.stroke();
			}
			this.canvas.setAttribute("aria-label", this.card.querySelector("h3").textContent + ", "
					+ this.series.map((s, k) => s.label + " " + formatNumber(this.values[k][n - 1], this.options.format)).join(", "));
		}

		onPointerMove(event) {
			if (!this.layout) {
				return;
			}
			const rect = this.canvas.getBoundingClientRect();
			const px = event.clientX - rect.left;
			const { left, plotWidth, n } = this.layout;
			const t0 = this.times[0];
			const t1 = this.times[n - 1];
			const t = t0 + ((px - left) / plotWidth) * (t1 - t0);
			let index = Math.round(((t - t0) / (t1 - t0)) * (n - 1));
			index = Math.max(0, Math.min(n - 1, index));
			this.showTooltip(index);
		}

		showTooltip(index) {
			if (!this.layout || index < 0) {
				return;
			}
			this.hoverIndex = index;
			this.draw();
			const tip = this.tooltip;
			tip.textContent = "";
			const head = document.createElement("div");
			head.className = "tip-date";
			head.textContent = formatDate(this.times[index]);
			tip.appendChild(head);
			this.series.forEach((s, k) => {
				const row = document.createElement("div");
				row.className = "tip-row";
				const key = document.createElement("span");
				key.className = "tip-key";
				key.style.background = "var(" + s.color + ")";
				const value = document.createElement("strong");
				value.textContent = formatNumber(this.values[k][index], this.options.format);
				const label = document.createElement("span");
				label.textContent = s.label;
				row.append(key, value, label);
				tip.appendChild(row);
			});
			tip.hidden = false;
			const px = this.layout.x(index);
			const plotWidth = this.plot.clientWidth;
			const tipWidth = tip.offsetWidth;
			tip.style.left = (px + 12 + tipWidth > plotWidth ? px - 12 - tipWidth : px + 12) + "px";
			tip.style.top = "8px";
		}

		hideTooltip() {
			this.hoverIndex = -1;
			this.tooltip.hidden = true;
			this.draw();
		}

		renderTable() {
			if (this.tableContainer.hidden) {
				return;
			}
			const table = document.createElement("table");
			const head = table.createTHead().insertRow();
			const dateHeader = document.createElement("th");
			dateHeader.textContent = "Day";
			head.appendChild(dateHeader);
			for (const s of this.series) {
				const th = document.createElement("th");
				th.textContent = s.label;
				head.appendChild(th);
			}
			const body = table.createTBody();
			const n = this.times.length;
			for (let i = n - 1; i >= Math.max(0, n - 30); i--) {
				const row = body.insertRow();
				row.insertCell().textContent = formatDate(this.times[i]);
				this.series.forEach((s, k) => {
					row.insertCell().textContent = formatNumber(this.values[k][i], this.options.format);
				});
			}
			this.tableContainer.textContent = "";
			const caption = document.createElement("p");
			caption.className = "table-caption";
			caption.textContent = n > 30 ? "Last 30 days, newest first" : "Newest first";
			this.tableContainer.append(caption, table);
		}
	}

	CE.LineChart = LineChart;
	CE.formatNumber = formatNumber;
	CE.formatDate = formatDate;
})(typeof self !== "undefined" ? self : globalThis);
