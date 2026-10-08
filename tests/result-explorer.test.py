import base64
import csv
import importlib.util
import io
import json
import unittest
from decimal import Decimal
from pathlib import Path

import numpy as np
import pandas as pd
from IPython.core.interactiveshell import InteractiveShell

spec = importlib.util.spec_from_file_location("explorer", Path(__file__).parents[1] / "webapps/better-notebooks/modules/result-explorer.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExplorerTests(unittest.TestCase):
    def setUp(self):
        self.engine = module.ResultExplorer()
        self.table = self.engine.capture(pd.DataFrame({"n": range(1000), "group": ["a", "b"] * 500}))

    def request(self, op, table=None, **kwargs):
        table = self.table if table is None else table
        result = self.engine.dispatch(dict(op=op, resultId=table["resultId"], generation=table["generation"], **kwargs))
        self.assertTrue(result["ok"], result)
        return result.get("result")

    def test_page_filter_multi_sort_on_complete_snapshot(self):
        page = self.request("page", offset=100, limit=100)
        self.assertEqual(page["rows"][0], [100, "a"])
        page = self.request("page", filters=[{"column": "c0", "op": "ge", "value": "900"}], sorts=[{"column": "c1", "direction": "desc"}, {"column": "c0", "direction": "desc"}])
        self.assertEqual(page["filteredRows"], 100)
        self.assertEqual(page["rows"][0], [999, "b"])

    def test_types_nulls_and_no_row_float_upcast(self):
        df = pd.DataFrame({"big": pd.Series([2**60, None], dtype="Int64"), "float": [1.5, np.inf], "decimal": [Decimal("1.234567890123456789"), None], "date": pd.to_datetime(["2026-01-01T00:00:00Z", None]), "empty": ["", None]})
        table = self.engine.capture(df)
        row = table["preview"]["rows"][0]
        self.assertEqual(row[0], {"type": "integer", "value": str(2**60)})
        self.assertEqual(row[2]["value"], "1.234567890123456789")
        self.assertEqual(row[3]["type"], "datetime")
        self.assertEqual(row[4], "")
        self.assertIsNone(table["preview"]["rows"][1][0])
        self.assertEqual(table["preview"]["rows"][1][1]["value"], "inf")
        json.dumps(table, allow_nan=False)
        numeric = self.engine.capture(pd.DataFrame({"a": [2**60+1], "b": [1.5]}))
        self.assertEqual(numeric["preview"]["rows"][0][0]["value"], str(2**60+1))

    def test_mutations_do_not_change_snapshot(self):
        nested = {"items": [1, 2]}
        df = pd.DataFrame({"n": [1], "nested": [nested]})
        table = self.engine.capture(df)
        nested["items"].append(3)
        df.loc[0, "n"] = 99
        page = self.request("page", table)
        self.assertEqual(page["rows"][0], [1, '{"items": [1, 2]}'])

    def test_duplicate_columns_and_multiindex(self):
        index = pd.MultiIndex.from_tuples([("a", 1), ("b", 2)], names=["group", "row"])
        df = pd.DataFrame([[2, 9], [1, 8]], columns=pd.MultiIndex.from_tuples([("x", "n"), ("x", "n")]), index=index)
        table = self.engine.capture(df)
        self.assertNotEqual(table["columns"][0]["id"], table["columns"][1]["id"])
        page = self.request("page", table, sorts=[{"column": "c1", "direction": "asc"}])
        self.assertEqual(page["index"][0], {"type": "tuple", "value": ["b", 2]})
        self.assertEqual(page["rows"][0], [1, 8])

    def test_empty_frame_and_nulls_last_stable(self):
        empty = self.engine.capture(pd.DataFrame({"x": pd.Series(dtype="int64")}))
        self.assertEqual(self.request("page", empty)["rows"], [])
        self.assertEqual(self.request("profile", empty)["rows"], 0)
        table = self.engine.capture(pd.DataFrame({"n": [None, 1, 1, 2], "s": ["null", "first", "second", "two"]}))
        page = self.request("page", table, sorts=[{"column": "c0", "direction": "desc"}])
        self.assertEqual([row[1] for row in page["rows"]], ["two", "first", "second", "null"])

    def test_filter_operators(self):
        table = self.engine.capture(pd.DataFrame({"n": [1, 2, None], "s": ["Abc", "Def", ""], "flag": pd.Series([True, False, None], dtype="boolean"), "date": pd.to_datetime(["2026-01-01", "2026-02-01", None])}))
        cases = [("c0", "between", "1", "2", 2), ("c1", "contains", "ABC", None, 1), ("c2", "eq", "false", None, 1), ("c0", "isNull", None, None, 1), ("c0", "notNull", None, None, 2), ("c3", "gt", "2026-01-15", None, 1)]
        for column, op, value, upper, count in cases:
            self.assertEqual(self.request("page", table, filters=[dict(column=column, op=op, value=value, upper=upper)])["filteredRows"], count)

    def test_chart_aggregations_and_histogram_cover_all_rows(self):
        chart = self.request("chart", chart={"kind": "bar", "x": "c1", "y": "c0", "aggregate": "sum"})
        self.assertEqual(chart["data"][0]["y"], [sum(range(0, 1000, 2)), sum(range(1, 1000, 2))])
        for aggregate in ("mean", "min", "max", "count"):
            self.assertEqual(self.request("chart", chart={"kind": "line", "x": "c1", "y": "c0", "aggregate": aggregate})["rows"], 1000)
        histogram = self.request("chart", chart={"kind": "histogram", "x": "c0"})
        self.assertEqual(sum(histogram["data"][0]["y"]), 1000)
        limited = self.engine.dispatch(dict(op="chart", resultId=self.table["resultId"], generation=self.table["generation"], chart={"kind": "bar", "x": "c0", "aggregate": "count"}))
        self.assertTrue(limited["ok"])
        large = self.engine.capture(pd.DataFrame({"n": range(6000), "y": range(6000)}))
        chart = self.request("chart", large, chart={"kind": "scatter", "x": "c0", "y": "c1"})
        self.assertTrue(chart["sampled"])
        self.assertEqual(len(chart["data"][0]["x"]), 5000)
        denied = self.engine.dispatch(dict(op="chart", resultId=large["resultId"], generation=large["generation"], chart={"kind": "bar", "x": "c0", "aggregate": "count"}))
        self.assertEqual(denied["code"], "TOO_MANY_GROUPS")

    def test_profile_statistics_match_pandas_after_filter(self):
        result = self.request("profile", filters=[{"column": "c0", "op": "ge", "value": "900"}])
        expected = pd.Series(range(900, 1000))
        stats = result["columns"][0]["statistics"]
        self.assertEqual(result["rows"], 100)
        self.assertEqual(stats["mean"], expected.mean())
        self.assertEqual(stats["std"], expected.std())
        self.assertEqual(stats["q1"], expected.quantile(.25))
        self.assertEqual(sum(result["columns"][0]["distribution"]["counts"]), 100)
        self.assertEqual(result["columns"][1]["cardinality"], 2)
        table = self.engine.capture(pd.DataFrame({"x": [1, None, 3], "date": pd.to_datetime(["2026-01-01", None, "2026-02-01"]), "mixed": [1, "text", None]}))
        profile = self.request("profile", table)
        self.assertEqual(profile["columns"][0]["missing"], 1)
        self.assertEqual(sum(profile["columns"][1]["distribution"]["counts"]), 2)
        self.assertFalse(profile["columns"][2]["supported"])

    def test_csv_full_filtered_sorted_quoted_and_visible_columns(self):
        self.table = self.engine.capture(pd.DataFrame({"n": range(2001), "text": ['a,"b"\nline'] * 2001}))
        start = self.request("exportStart", columns=["c1"], filters=[{"column": "c0", "op": "ge", "value": "100"}], sorts=[{"column": "c0", "direction": "desc"}])
        chunks = []
        while True:
            chunk = self.request("exportChunk", token=start["token"])
            chunks.append(chunk["text"])
            if chunk["done"]:
                break
        rows = list(csv.reader(io.StringIO("".join(chunks))))
        self.assertEqual(len(rows), 1902)
        self.assertEqual(rows[0], ["text"])
        self.assertEqual(rows[-1], ['a,"b"\nline'])
        self.request("exportClose", token=start["token"])
        self.assertFalse(self.engine.exports)

    def test_budgets_eviction_expiry_generation_and_release(self):
        clock = [0]
        self.engine = module.ResultExplorer(snapshot_bytes=10000, kernel_bytes=1600, ttl=10, clock=lambda: clock[0])
        first = self.engine.capture(pd.DataFrame({"n": range(30)}))
        second = self.engine.capture(pd.DataFrame({"n": range(30)}))
        self.assertNotIn(first["resultId"], self.engine.snapshots)
        clock[0] = 11
        response = self.engine.dispatch(dict(op="describe", resultId=second["resultId"], generation=second["generation"]))
        self.assertEqual(response["code"], "EXPIRED")
        unavailable = self.engine.capture(pd.DataFrame({"n": range(1000)}))
        self.assertFalse(unavailable["available"])
        self.assertTrue(unavailable["preview"]["truncated"])
        small = self.engine.capture(pd.DataFrame({"n": [1]}))
        response = self.engine.dispatch(dict(op="describe", resultId=small["resultId"], generation="old"))
        self.assertEqual(response["code"], "EXPIRED")
        self.request("release", small)
        self.assertNotIn(small["resultId"], self.engine.snapshots)

    def test_transfer_limits_and_invalid_requests(self):
        self.engine = module.ResultExplorer(preview_bytes=600)
        table = self.engine.capture(pd.DataFrame({"s": ["x" * 200] * 100}))
        self.assertLessEqual(len(json.dumps(table["preview"]).encode()), 700)
        self.assertTrue(table["preview"]["truncated"])
        response = self.engine.dispatch(dict(op="page", resultId=table["resultId"], generation=table["generation"], filters=[{"column": "c0", "op": "exec", "value": "__import__('os')"}]))
        self.assertFalse(response["ok"])
        self.assertFalse(self.engine.dispatch({"op": "unknown"})["ok"])
        payload = base64.b64encode(json.dumps(dict(op="page", resultId=table["resultId"], generation=table["generation"])).encode()).decode()
        self.assertTrue(self.engine.request(payload).data["ok"])

    def test_million_rows_stays_bounded_and_computes_complete_result(self):
        frame = pd.DataFrame({"n": np.arange(1_000_000), "group": pd.Categorical(np.arange(1_000_000) % 10)})
        table = self.engine.capture(frame)
        self.assertTrue(table["available"])
        self.assertLess(len(json.dumps(table).encode()), 20_000)
        page = self.request("page", table, filters=[{"column": "c0", "op": "ge", "value": "999900"}])
        self.assertEqual(page["filteredRows"], 100)
        self.assertEqual(page["rows"][-1][0], 999999)
        chart = self.request("chart", table, chart={"kind": "bar", "x": "c1", "aggregate": "count"})
        self.assertEqual(sum(chart["data"][0]["y"]), 1_000_000)
        profile = self.request("profile", table)
        self.assertEqual(profile["columns"][0]["cardinality"], 1_000_000)
        self.assertEqual(profile["columns"][0]["statistics"]["mean"], 499999.5)

    def test_expression_final_display_and_query_reply_json(self):
        from IPython.display import display
        shell = InteractiveShell.instance()
        explorer = module.install()
        bundles = []
        original_hook = shell.displayhook.write_format_data
        original_publish = shell.display_pub.publish
        shell.displayhook.write_format_data = lambda data, metadata=None: bundles.append(data)
        shell.display_pub.publish = lambda data, metadata=None, **kwargs: bundles.append(data)
        try:
            shell.user_ns["bn_test_df"] = pd.DataFrame({"n": [1, 2, 3]})
            shell.user_ns["bn_test_display"] = display
            shell.run_cell("bn_test_df", store_history=False)
            shell.run_cell("bn_test_display(bn_test_df.head(2))", store_history=False)
            tables = [bundle[module.MIME] for bundle in bundles if module.MIME in bundle]
            self.assertEqual([table["totalRows"] for table in tables], [3, 2])
            payload = base64.b64encode(json.dumps(dict(op="page", resultId=tables[0]["resultId"], generation=tables[0]["generation"])).encode()).decode()
            data, _ = shell.display_formatter.format(explorer.request(payload))
            self.assertEqual(data["application/json"]["result"]["rows"], [[1], [2], [3]])
        finally:
            shell.displayhook.write_format_data = original_hook
            shell.display_pub.publish = original_publish
            shell.user_ns.pop("bn_test_df", None)
            shell.user_ns.pop("bn_test_display", None)

    def test_real_ipython_formatter_and_bundle_persistence(self):
        shell = InteractiveShell.instance()
        explorer = module.install()
        df = pd.DataFrame({"n": range(250)})
        bundle, metadata = shell.display_formatter.format(df)
        self.assertIn(module.MIME, bundle)
        self.assertIn("text/html", bundle)
        descriptor = json.loads(json.dumps(bundle[module.MIME]))
        result = explorer.dispatch(dict(op="page", resultId=descriptor["resultId"], generation=descriptor["generation"], offset=100, limit=100))
        self.assertEqual(result["result"]["rows"][0], [100])
        # Same bootstrap namespace as the shipped JS execution path.
        exec(Path(spec.origin).read_text() + "\ninstall()", {})
        self.assertIs(shell.user_ns["_bn_explorer"], explorer)
        self.assertIs(module.install(), explorer)


if __name__ == "__main__":
    unittest.main()
