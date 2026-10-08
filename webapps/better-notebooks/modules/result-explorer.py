"""Kernel-local, versioned DataFrame explorer. No user expressions are evaluated here."""
import base64
import csv
import datetime as dt
import io
import json
import math
import time
import uuid
from collections import OrderedDict
from decimal import Decimal

import numpy as np
import pandas as pd

MIME = "application/vnd.better-notebooks.table.v1+json"


def missing(value):
    if value is None or value is pd.NA or value is pd.NaT:
        return True
    try:
        result = pd.isna(value)
        return bool(result) if isinstance(result, (bool, np.bool_)) else False
    except (TypeError, ValueError):
        return False


def encode(value):
    if missing(value):
        return None
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (int, np.integer)):
        value = int(value)
        return value if abs(value) <= 9007199254740991 else {"type": "integer", "value": str(value)}
    if isinstance(value, (float, np.floating)):
        value = float(value)
        return value if math.isfinite(value) else {"type": "float", "value": str(value)}
    if isinstance(value, Decimal):
        return {"type": "decimal", "value": str(value)}
    if isinstance(value, (pd.Timestamp, dt.datetime, dt.date, np.datetime64)):
        return {"type": "datetime", "value": pd.Timestamp(value).isoformat()}
    if isinstance(value, (pd.Timedelta, dt.timedelta, np.timedelta64)):
        return {"type": "duration", "value": str(value)}
    if isinstance(value, tuple):
        return {"type": "tuple", "value": [encode(v) for v in value]}
    return str(value)


def freeze(value):
    # Copy supported scalar objects; freeze containers/custom objects as text.
    # This deliberately never retains references to mutable nested objects.
    if isinstance(value, (list, dict, set, tuple)):
        try:
            return json.dumps(value, default=str, ensure_ascii=False)
        except (TypeError, ValueError):
            return str(value)
    if missing(value) or isinstance(value, (str, bool, int, float, Decimal, dt.date, dt.timedelta, np.generic)):
        return value
    return str(value)


def logical(series):
    dtype = series.dtype
    if pd.api.types.is_bool_dtype(dtype):
        return "boolean"
    if pd.api.types.is_integer_dtype(dtype):
        return "integer"
    if pd.api.types.is_numeric_dtype(dtype) and not pd.api.types.is_complex_dtype(dtype):
        return "number"
    if pd.api.types.is_datetime64_any_dtype(dtype):
        return "datetime"
    if isinstance(dtype, pd.CategoricalDtype):
        return "category"
    if pd.api.types.is_object_dtype(dtype):
        values = series.dropna()
        # Inspect every scalar for reliable type inference, not just the preview.
        if all(isinstance(v, str) for v in values):
            return "string"
        if len(values) and all(isinstance(v, Decimal) for v in values):
            return "decimal"
        if len(values) and all(isinstance(v, (dt.date, dt.datetime, pd.Timestamp)) for v in values):
            return "datetime"
        return "object"
    if pd.api.types.is_string_dtype(dtype):
        return "string"
    return "object"


class ExplorerError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


class ResultExplorer:
    def __init__(self, snapshot_bytes=128 * 1024**2, kernel_bytes=256 * 1024**2,
                 ttl=1800, preview_bytes=1024**2, clock=time.monotonic):
        self.generation = str(uuid.uuid4())
        self.snapshot_bytes = snapshot_bytes
        self.kernel_bytes = kernel_bytes
        self.ttl = ttl
        self.preview_bytes = preview_bytes
        self.clock = clock
        self.snapshots = OrderedDict()
        self.exports = {}

    def sweep(self):
        now = self.clock()
        for key, value in list(self.snapshots.items()):
            if now - value["used"] > self.ttl:
                self.release(key)
        for key, value in list(self.exports.items()):
            if now - value["used"] > self.ttl:
                self.exports.pop(key, None)

    def release(self, key):
        self.snapshots.pop(key, None)
        for token, value in list(self.exports.items()):
            if value["resultId"] == key:
                self.exports.pop(token, None)

    def rows(self, frame, positions, limit, budget=None):
        rows, indexes, size = [], [], 0
        budget = max(0, (self.preview_bytes if budget is None else budget) - 128)
        for position in positions[:limit]:
            row = [encode(frame.iat[int(position), i]) for i in range(len(frame.columns))]
            index = encode(frame.index[int(position)])
            cost = len(json.dumps([row, index], ensure_ascii=False, allow_nan=False).encode("utf-8"))
            if size + cost > budget:
                break
            rows.append(row)
            indexes.append(index)
            size += cost
        return {"rows": rows, "index": indexes, "truncated": len(rows) < len(positions)}

    def capture(self, source):
        self.sweep()
        if len(source.columns) > 2000:
            # Bound descriptor size too. Native HTML/plain output remains available.
            return {"version": 1, "available": False, "reason": "More than 2,000 columns; reduce the displayed result.", "columns": [], "totalRows": len(source), "preview": {"rows": [], "index": [], "truncated": True}}
        columns = [{"id": "c" + str(i), "label": str(name), "name": encode(name),
                    "pandasType": str(source.iloc[:, i].dtype), "type": logical(source.iloc[:, i])}
                   for i, name in enumerate(source.columns)]
        key = str(uuid.uuid4())
        descriptor = {"version": 1, "resultId": key, "generation": self.generation,
                      "columns": columns, "indexNames": [encode(n) for n in source.index.names],
                      "totalRows": len(source), "available": True}
        if len(json.dumps(descriptor, ensure_ascii=False).encode("utf-8")) > self.preview_bytes:
            return {"version": 1, "available": False, "reason": "Column schema exceeds transfer budget.", "columns": [], "totalRows": len(source), "preview": {"rows": [], "index": [], "truncated": True}}
        descriptor["preview"] = self.rows(source, np.arange(min(len(source), 101)), 100)
        descriptor["preview"]["truncated"] = len(descriptor["preview"]["rows"]) < len(source)
        descriptor_bytes = len(json.dumps(descriptor, ensure_ascii=False, allow_nan=False).encode("utf-8"))
        estimated = int(source.memory_usage(index=True, deep=True).sum()) + descriptor_bytes
        if estimated > min(self.snapshot_bytes, self.kernel_bytes):
            descriptor.update(available=False, reason="Snapshot memory budget exceeded; display a smaller DataFrame.")
            return descriptor
        frame = source.copy(deep=True)
        frame.index = source.index.copy(deep=True)
        # Use positional assignment so duplicate column labels remain valid.
        for i in range(len(columns)):
            if pd.api.types.is_object_dtype(frame.iloc[:, i].dtype):
                values = frame.iloc[:, i].map(freeze)
                if hasattr(frame, "isetitem"):
                    frame.isetitem(i, values)
                else:
                    frame.iloc[:, i] = values
        if isinstance(frame.index, pd.MultiIndex):
            frame.index = pd.MultiIndex.from_tuples([tuple(freeze(v) for v in item) for item in frame.index], names=frame.index.names)
        elif pd.api.types.is_object_dtype(frame.index.dtype):
            frame.index = pd.Index([freeze(v) for v in frame.index], name=frame.index.name)
        estimated = int(frame.memory_usage(index=True, deep=True).sum()) + descriptor_bytes
        if estimated > min(self.snapshot_bytes, self.kernel_bytes):
            descriptor.update(available=False, reason="Frozen snapshot memory budget exceeded.")
            return descriptor
        while self.snapshots and (len(self.snapshots) >= 64 or sum(v["bytes"] for v in self.snapshots.values()) + estimated > self.kernel_bytes):
            self.release(next(iter(self.snapshots)))
        self.snapshots[key] = {"frame": frame, "descriptor": descriptor, "bytes": estimated,
                               "used": self.clock(), "profileCache": OrderedDict(), "profileCacheBytes": {}}
        return descriptor

    def get(self, request):
        self.sweep()
        if request.get("generation") != self.generation:
            raise ExplorerError("EXPIRED", "Kernel changed. Reexecute the cell to explore the complete result.")
        key = request.get("resultId")
        if key not in self.snapshots:
            raise ExplorerError("EXPIRED", "Snapshot expired or was evicted. Reexecute the cell.")
        snapshot = self.snapshots[key]
        snapshot["used"] = self.clock()
        self.snapshots.move_to_end(key)
        return snapshot

    def column(self, snapshot, key):
        columns = snapshot["descriptor"]["columns"]
        match = next((i for i, c in enumerate(columns) if c["id"] == key), None)
        if match is None:
            raise ExplorerError("COLUMN", "Unknown column: " + str(key))
        return match, columns[match]

    def value(self, text, kind):
        if kind == "integer":
            return int(text)
        if kind == "number":
            return float(text)
        if kind == "decimal":
            return Decimal(str(text))
        if kind == "datetime":
            return pd.Timestamp(text)
        if kind == "boolean":
            if str(text).lower() not in ("true", "false"):
                raise ValueError("Use true or false")
            return str(text).lower() == "true"
        return str(text)

    def view(self, snapshot, request):
        frame = snapshot["frame"]
        mask = pd.Series(True, index=np.arange(len(frame)))
        filters = request.get("filters", [])
        sorts = request.get("sorts", [])
        if not isinstance(filters, list) or len(filters) > 2000 or not isinstance(sorts, list) or len(sorts) > 2000:
            raise ValueError("Invalid filters or sorts")
        for f in filters:
            i, column = self.column(snapshot, f["column"])
            series = frame.iloc[:, i].reset_index(drop=True)
            if column["type"] == "datetime" and not pd.api.types.is_datetime64_any_dtype(series.dtype):
                series = pd.to_datetime(series)
            op = f.get("op")
            if op == "isNull":
                selected = series.isna()
            elif op == "notNull":
                selected = series.notna()
            elif op == "contains" and column["type"] in ("string", "category", "object"):
                selected = series.astype("string").str.contains(str(f.get("value", "")), case=False, regex=False, na=False)
            elif op in ("eq", "ne", "gt", "ge", "lt", "le", "between"):
                value = self.value(f.get("value"), column["type"])
                if op == "between":
                    selected = (series >= value) & (series <= self.value(f.get("upper"), column["type"]))
                else:
                    selected = {"eq": series.eq, "ne": series.ne, "gt": series.gt,
                                "ge": series.ge, "lt": series.lt, "le": series.le}[op](value)
                selected &= series.notna()
            else:
                raise ValueError("Unsupported filter operator")
            mask &= selected.fillna(False)
        positions = np.flatnonzero(mask.to_numpy(dtype=bool))
        if sorts:
            keys = pd.DataFrame(index=np.arange(len(positions)))
            directions = []
            for n, sort in enumerate(sorts):
                i, column = self.column(snapshot, sort["column"])
                series = frame.iloc[positions, i].reset_index(drop=True)
                if column["type"] == "datetime":
                    series = pd.to_datetime(series)
                elif column["type"] == "object":
                    series = series.map(lambda v: None if missing(v) else str(v))
                keys[n] = series
                if sort.get("direction") not in ("asc", "desc"):
                    raise ValueError("Invalid sort direction")
                directions.append(sort["direction"] == "asc")
            # Original position is the explicit final tie breaker.
            keys[len(sorts)] = positions
            order = keys.sort_values(list(keys.columns), ascending=directions + [True], na_position="last", kind="mergesort").index
            positions = positions[order]
        return positions

    def histogram(self, series, bins=20):
        values = np.asarray(series.dropna(), dtype=float)
        values = values[np.isfinite(values)]
        if not len(values):
            return {"edges": [], "counts": []}
        counts, edges = np.histogram(values, bins=bins)
        return {"edges": [encode(v) for v in edges], "counts": counts.tolist()}

    def chart(self, snapshot, request, positions):
        config = request.get("chart", {})
        kind = config.get("kind", "bar")
        if kind not in ("bar", "line", "scatter", "histogram"):
            raise ValueError("Unsupported chart")
        xi, xc = self.column(snapshot, config.get("x"))
        frame = snapshot["frame"].iloc[positions]
        x = frame.iloc[:, xi].reset_index(drop=True)
        if kind == "histogram":
            if xc["type"] not in ("integer", "number", "decimal"):
                raise ValueError("Histogram requires a numeric X axis")
            hist = self.histogram(x, 30)
            edges = hist["edges"]
            trace = {"type": "bar", "x": [(edges[i] + edges[i+1])/2 for i in range(len(edges)-1)], "y": hist["counts"]}
            return {"data": [trace], "rows": len(positions), "sampled": False}
        aggregate = config.get("aggregate", "count")
        if aggregate not in ("count", "sum", "mean", "min", "max"):
            raise ValueError("Unsupported aggregation")
        yi, yc = (None, None) if aggregate == "count" and kind != "scatter" else self.column(snapshot, config.get("y"))
        if yc and yc["type"] not in ("integer", "number", "decimal"):
            raise ValueError("Y axis must be numeric")
        group_key = config.get("series")
        group = None
        if group_key:
            gi, _ = self.column(snapshot, group_key)
            group = frame.iloc[:, gi].reset_index(drop=True)
        if kind == "scatter":
            if xc["type"] not in ("integer", "number", "decimal", "datetime"):
                raise ValueError("Scatter X axis must be numeric or temporal")
            subset = np.linspace(0, len(frame)-1, min(5000, len(frame)), dtype=int) if len(frame) else []
            groups = [None] if group is None else list(group.drop_duplicates())
            if len(groups) > 1000:
                raise ExplorerError("TOO_MANY_GROUPS", "More than 1,000 series. Add a filter.")
            traces = []
            for value in groups:
                selected = [int(p) for p in subset if group is None or (missing(value) and missing(group.iloc[p])) or group.iloc[p] == value]
                traces.append({"type": "scatter", "mode": "markers", "name": str(value) if group is not None else yc["label"], "x": [encode(x.iloc[p]) for p in selected], "y": [encode(frame.iloc[p, yi]) for p in selected]})
            return {"data": traces, "rows": len(frame), "sampled": len(frame) > 5000, "points": len(subset)}
        data = pd.DataFrame({"x": x})
        if group is not None:
            data["series"] = group
        if yi is not None:
            data["y"] = frame.iloc[:, yi].reset_index(drop=True)
        grouping = ["x", "series"] if group is not None else ["x"]
        grouped = data.groupby(grouping, dropna=False, observed=True, sort=True)
        if grouped.ngroups > 1000:
            raise ExplorerError("TOO_MANY_GROUPS", "More than 1,000 groups. Add a filter.")
        result = grouped.size().rename("y").reset_index() if aggregate == "count" else grouped["y"].agg(aggregate).reset_index()
        traces = []
        pieces = [(None, result)] if group is None else list(result.groupby("series", dropna=False, observed=True))
        for label, part in pieces:
            traces.append({"type": "bar" if kind == "bar" else "scatter", "mode": "lines+markers", "name": str(label) if group is not None else aggregate,
                           "x": [encode(v) for v in part["x"]], "y": [encode(v) for v in part["y"]]})
        return {"data": traces, "rows": len(frame), "sampled": False}

    def profile(self, snapshot, request, positions):
        cache_key = json.dumps(request.get("filters", []), sort_keys=True)
        if cache_key in snapshot["profileCache"]:
            snapshot["profileCache"].move_to_end(cache_key)
            return snapshot["profileCache"][cache_key]
        frame = snapshot["frame"].iloc[positions]
        result = {"rows": len(frame), "columns": [], "truncated": False}
        size = 0
        for i, column in enumerate(snapshot["descriptor"]["columns"]):
            series = frame.iloc[:, i]
            nulls = int(series.isna().sum())
            entry = {"id": column["id"], "missing": nulls, "missingPercent": 100 * nulls / len(frame) if len(frame) else 0,
                     "supported": column["type"] != "object"}
            if entry["supported"]:
                entry["cardinality"] = int(series.nunique(dropna=True))
                values = series.dropna()
                if column["type"] in ("integer", "number", "decimal"):
                    numeric = pd.to_numeric(values).astype(float)
                    numeric = numeric[np.isfinite(numeric)]
                    entry["statistics"] = {"min": encode(values.min()) if len(values) else None, "max": encode(values.max()) if len(values) else None,
                                           "mean": encode(numeric.mean()), "median": encode(numeric.median()), "q1": encode(numeric.quantile(.25)),
                                           "q3": encode(numeric.quantile(.75)), "std": encode(numeric.std())}
                    entry["distribution"] = self.histogram(numeric)
                elif column["type"] == "datetime":
                    dates = pd.to_datetime(values)
                    entry["statistics"] = {"min": encode(dates.min()), "max": encode(dates.max())}
                    hist = self.histogram(pd.Series(dates.astype("int64")))
                    hist["edges"] = [encode(pd.Timestamp(int(v), tz=dates.dt.tz)) for v in hist["edges"]]
                    entry["distribution"] = hist
                else:
                    counts = values.value_counts().head(20)
                    entry["distribution"] = {"values": [encode(v) for v in counts.index], "counts": [int(v) for v in counts.values], "other": int(len(values) - counts.sum())}
            cost = len(json.dumps(entry, ensure_ascii=False, allow_nan=False).encode("utf-8"))
            if size + cost > self.preview_bytes:
                result["truncated"] = True
                break
            result["columns"].append(entry)
            size += cost
        cost = len(json.dumps(result, ensure_ascii=False, allow_nan=False).encode("utf-8"))
        while snapshot["profileCache"] and (len(snapshot["profileCache"]) >= 3 or snapshot["bytes"] + cost > self.snapshot_bytes):
            old, _ = snapshot["profileCache"].popitem(last=False)
            snapshot["bytes"] -= snapshot["profileCacheBytes"].pop(old)
        while len(self.snapshots) > 1 and sum(v["bytes"] for v in self.snapshots.values()) + cost > self.kernel_bytes:
            self.release(next(iter(self.snapshots)))
        if snapshot["bytes"] + cost <= self.snapshot_bytes and sum(v["bytes"] for v in self.snapshots.values()) + cost <= self.kernel_bytes:
            snapshot["profileCache"][cache_key] = result
            snapshot["profileCacheBytes"][cache_key] = cost
            snapshot["bytes"] += cost
        return result

    def csv_value(self, value):
        encoded = encode(value)
        if encoded is None:
            return ""
        if isinstance(encoded, dict):
            return encoded["value"] if not isinstance(encoded["value"], list) else json.dumps(encoded["value"], ensure_ascii=False)
        return encoded

    def dispatch(self, request):
        try:
            if not isinstance(request, dict):
                raise ValueError("Request must be an object")
            op = request.get("op")
            if op not in ("describe", "page", "chart", "profile", "exportStart", "exportChunk", "exportClose", "release"):
                raise ValueError("Unknown explorer operation")
            snapshot = self.get(request)
            if op == "release":
                self.release(request["resultId"])
                return {"ok": True}
            if op == "describe":
                return {"ok": True, "result": snapshot["descriptor"]}
            if op == "exportClose":
                self.exports.pop(request.get("token"), None)
                return {"ok": True}
            if op == "exportChunk":
                item = self.exports.get(request.get("token"))
                if not item or item["resultId"] != request["resultId"]:
                    raise ExplorerError("EXPIRED", "Export expired")
                output = io.StringIO(newline="")
                writer = csv.writer(output)
                if item["offset"] == 0:
                    writer.writerow([snapshot["descriptor"]["columns"][i]["label"] for i in item["columns"]])
                start = item["offset"]
                size = len(output.getvalue().encode("utf-8"))
                if size > 256 * 1024:
                    raise ExplorerError("ROW_TOO_LARGE", "CSV header exceeds the transfer budget.")
                for position in item["positions"][start:start+1000]:
                    line = io.StringIO(newline="")
                    csv.writer(line).writerow([self.csv_value(snapshot["frame"].iat[int(position), i]) for i in item["columns"]])
                    text = line.getvalue()
                    cost = len(text.encode("utf-8"))
                    if cost > 256 * 1024:
                        raise ExplorerError("ROW_TOO_LARGE", "One CSV row exceeds the transfer budget. No partial export can be downloaded.")
                    if size + cost > 256 * 1024:
                        if item["offset"] == start:
                            raise ExplorerError("ROW_TOO_LARGE", "CSV header and first row exceed the transfer budget.")
                        break
                    output.write(text)
                    size += cost
                    item["offset"] += 1
                item["used"] = self.clock()
                result = {"text": output.getvalue(), "done": item["offset"] >= len(item["positions"]), "rows": item["offset"], "total": len(item["positions"])}
                return {"ok": True, "result": result}
            positions = self.view(snapshot, request)
            if op == "page":
                offset, limit = int(request.get("offset", 0)), int(request.get("limit", 100))
                if offset < 0 or limit not in (50, 100, 500):
                    raise ValueError("Invalid page bounds")
                result = self.rows(snapshot["frame"], positions[offset:], limit)
                if len(positions) > offset and not result["rows"]:
                    raise ExplorerError("ROW_TOO_LARGE", "A row exceeds the transfer budget. Display fewer columns in Python.")
                result.update(offset=offset, nextOffset=offset+len(result["rows"]), filteredRows=len(positions), totalRows=len(snapshot["frame"]))
            elif op == "chart":
                result = self.chart(snapshot, request, positions)
                if len(json.dumps(result, ensure_ascii=False, allow_nan=False).encode("utf-8")) > self.preview_bytes:
                    raise ExplorerError("CHART_TOO_LARGE", "Chart exceeds the transfer budget. Add a filter.")
            elif op == "profile":
                result = self.profile(snapshot, request, positions)
            elif op == "exportStart":
                keys = request.get("columns", [c["id"] for c in snapshot["descriptor"]["columns"]])
                if not keys:
                    raise ValueError("Select at least one export column")
                columns = [self.column(snapshot, key)[0] for key in keys]
                if len(self.exports) >= 4:
                    raise ExplorerError("EXPORT_BUSY", "Four exports are already active. Finish or cancel an export first.")
                token = str(uuid.uuid4())
                self.exports[token] = {"resultId": request["resultId"], "positions": positions, "columns": columns, "offset": 0, "used": self.clock()}
                result = {"token": token, "total": len(positions)}
            return {"ok": True, "result": result}
        except ExplorerError as error:
            return {"ok": False, "code": error.code, "error": str(error)}
        except Exception as error:
            return {"ok": False, "code": "INVALID_REQUEST", "error": str(error)}

    def request(self, payload):
        from IPython.display import JSON
        return JSON(self.dispatch(json.loads(base64.b64decode(payload).decode("utf-8"))))


def install(settings=None):
    from IPython import get_ipython
    from IPython.core.formatters import JSONFormatter
    shell = get_ipython()
    if shell is None:
        return None
    current = shell.user_ns.get("_bn_explorer")
    if current is not None and getattr(current, "protocol_version", None) == 1:
        return current
    explorer = ResultExplorer(**(settings or {}))
    explorer.protocol_version = 1
    formatter = JSONFormatter(format_type=MIME)
    formatter.for_type(pd.DataFrame, explorer.capture)
    shell.display_formatter.formatters[MIME] = formatter
    shell.user_ns["_bn_explorer"] = explorer
    return explorer
