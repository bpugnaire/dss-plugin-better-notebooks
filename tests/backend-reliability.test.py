"""Run the delivered Flask routes with an in-memory DSS API, no DSS required."""
import copy
import runpy
import sys
import threading
import time
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from flask import Flask


class Content:
    def __init__(self, project, name):
        self.project = project
        self.name = name
        with project.guard:
            self.content = copy.deepcopy(project.documents[name])

    def get_raw(self):
        return copy.deepcopy(self.content)

    def save(self):
        time.sleep(0.01)  # Make races observable without a route lock.
        with self.project.guard:
            self.project.documents[self.name] = copy.deepcopy(self.content)
            self.project.writes += 1


class Notebook:
    def __init__(self, project, name):
        self.project, self.name = project, name

    def get_content(self):
        return Content(self.project, self.name)

    def delete(self):
        del self.project.documents[self.name]


class Project:
    project_key = 'P'

    def __init__(self):
        self.guard = threading.Lock()
        self.writes = 0
        self.documents = {'A': {'nbformat': 4, 'nbformat_minor': 5, 'metadata': {'custom': {'value': 'é'}}, 'cells': [{'id': 'stable', 'cell_type': 'code', 'source': ['x=1'], 'execution_count': None, 'outputs': [], 'metadata': {'custom': 12}, 'unknownField': {'x': 1}}], 'unknownTop': [1, 2]}}

    def get_jupyter_notebook(self, name):
        return Notebook(self, name)

    def create_jupyter_notebook(self, name, content):
        if name in self.documents:
            raise ValueError('Already exists')
        self.documents[name] = copy.deepcopy(content)


class ReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.project = Project()
        self.app = Flask(__name__)
        api = types.SimpleNamespace(get_default_project=lambda: self.project, list_code_envs=lambda: [])
        dataiku = types.ModuleType('dataiku')
        dataiku.api_client = lambda: api
        sys.modules['dataiku'] = dataiku
        self.backend = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'webapps/better-notebooks/backend.py'), init_globals={'app': self.app})
        self.client = self.app.test_client()

    def initial(self):
        return self.client.get('/notebooks/A').get_json()

    def test_revision_is_canonical_and_returned_everywhere(self):
        initial = self.initial()
        self.assertEqual(len(initial['revision']), 64)
        doc = initial['notebook']
        revision = self.backend['notebook_revision']
        self.assertEqual(revision(doc), revision(dict(reversed(list(doc.items())))))
        created = self.client.post('/notebooks', json={'name': 'B'}).get_json()
        copied = self.client.post('/notebooks/A/copy', json={'name': 'C'}).get_json()
        self.assertIn('revision', created)
        self.assertTrue(created['notebook']['cells'][0]['id'])
        self.assertEqual(copied['revision'], initial['revision'])

    def test_missing_revision_and_stale_revision_never_overwrite(self):
        initial = self.initial()
        doc = copy.deepcopy(initial['notebook'])
        doc['cells'][0]['source'] = ['local']
        self.assertEqual(self.client.put('/notebooks/A', json={'notebook': doc}).status_code, 428)
        response = self.client.put('/notebooks/A', json={'notebook': doc, 'expectedRevision': 'stale'})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()['code'], 'NOTEBOOK_CONFLICT')
        self.assertEqual(self.initial(), initial)
        self.assertEqual(self.project.writes, 0)

    def test_save_preserves_document_and_idempotent_retry_does_not_rewrite(self):
        initial = self.initial()
        doc = copy.deepcopy(initial['notebook'])
        doc['cells'][0]['source'] = ['x=2']
        response = self.client.put('/notebooks/A', json={'notebook': doc, 'expectedRevision': initial['revision']})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['notebook'], doc)
        self.assertNotEqual(response.get_json()['revision'], initial['revision'])
        retry = self.client.put('/notebooks/A', json={'notebook': doc, 'expectedRevision': initial['revision']})
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(self.project.writes, 1)

    def test_concurrent_writers_with_same_revision_only_one_succeeds(self):
        initial = self.initial()
        barrier = threading.Barrier(2)

        def save(source):
            doc = copy.deepcopy(initial['notebook'])
            doc['cells'][0]['source'] = [source]
            barrier.wait()
            with self.app.test_client() as client:
                return client.put('/notebooks/A', json={'notebook': doc, 'expectedRevision': initial['revision']}).status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(save, ['a', 'b']))
        self.assertEqual(sorted(results), [200, 409])
        self.assertEqual(self.project.writes, 1)
        self.assertEqual(self.backend['_notebook_locks'], {})

    def test_save_acknowledges_dss_normalization_and_next_edit_succeeds(self):
        initial = self.initial()
        original_save = Content.save

        def normalize_save(content):
            original_save(content)
            # DSS changes storage, while get_raw() on this object stays stale.
            with content.project.guard:
                stored = content.project.documents[content.name]
                stored['metadata']['dss_normalized'] = True
                stored['cells'][0]['source'] = ''.join(stored['cells'][0]['source'])

        from unittest.mock import patch
        with patch.object(Content, 'save', normalize_save):
            doc = copy.deepcopy(initial['notebook'])
            doc['cells'][0]['source'] = ['x=2']
            response = self.client.put('/notebooks/A', json={'notebook': doc, 'expectedRevision': initial['revision']})
        self.assertEqual(response.status_code, 200)
        acknowledged = response.get_json()
        self.assertEqual(acknowledged, self.initial())
        self.assertTrue(acknowledged['notebook']['metadata']['dss_normalized'])
        doc = copy.deepcopy(acknowledged['notebook'])
        doc['cells'][0]['source'] = ['x=3']
        next_save = self.client.put('/notebooks/A', json={'notebook': doc, 'expectedRevision': acknowledged['revision']})
        self.assertEqual(next_save.status_code, 200)
        self.assertEqual(self.initial()['notebook']['cells'][0]['source'], ['x=3'])

    def test_invalid_document_does_not_write(self):
        response = self.client.put('/notebooks/A', json={'notebook': {'cells': 'wrong'}, 'expectedRevision': 'r'})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.project.writes, 0)


if __name__ == '__main__':
    unittest.main()
