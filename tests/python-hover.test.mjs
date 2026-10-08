import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pythonSourceHelp} from '../webapps/better-notebooks/modules/python-hover.js';
const hover=(code, name, preceding=[])=>pythonSourceHelp(code,code.lastIndexOf(name)+name.length,preceding);

test('function signature and docstring are available in an unexecuted cell',()=>{
  const code='def greet(name: str, retries=2):\n    """Say hello to the supplied name."""\n    return name\n\ngreet("Alex")';
  assert.match(hover(code,'greet'),/greet\(name: str, retries=2\)/);
  assert.match(hover(code,'greet'),/Say hello to the supplied name/);
});
test('definitions in preceding unexecuted cells provide help',()=>{
  assert.match(hover('calculate(2)','calculate',['def calculate(value):\n    """Calculate a score."""\n    return value']),/Calculate a score/);
});
test('imports and dataframe calls resolve aliases before any execution',()=>{
  assert.match(hover('import pandas as frame\nframe.read_csv("x")','read_csv'),/pandas.read_csv/);
  assert.match(hover('from pandas import read_csv as load\nload("x")','load'),/pandas.read_csv/);
  assert.match(hover('df.head()','head',['import pandas as pd\ndf = pd.read_csv("x")']),/head\(n=5\)/);
  assert.match(hover('df.describe()','describe',['import pandas as pd\ndf: pd.DataFrame = pd.read_csv("x")']),/descriptive statistics/);
});
test('Dataiku dataset and dataframe help follows source assignments',()=>{
  const above='import dataiku\ndataset = dataiku.Dataset("A")\ndf = dataset.get_dataframe()';
  assert.match(hover('dataset.get_dataframe()','get_dataframe',[above]),/DSS dataset/);
  assert.match(hover('df.head()','head',[above]),/first n rows/);
});
test('source declarations shadow builtin and imported help',()=>{
  assert.match(hover('def len(value):\n    """Custom length."""\n    return 1\nlen([])','len'),/Custom length/);
  assert.doesNotMatch(hover('import pandas as pd\npd = 42\npd.read_csv("x")','read_csv'),/DataFrame/);
});
test('comments, strings and nested imports do not invent global bindings',()=>{
  assert.equal(hover('# import pandas as fake\nfake.read_csv("x")','read_csv'),'');
  assert.equal(hover('text = "import pandas as fake"\nfake.read_csv("x")','read_csv'),'');
  assert.equal(hover('def f():\n    import pandas as fake\nfake.read_csv("x")','read_csv'),'');
  assert.equal(hover('"print"','print'),'');
});
test('unknown imports identify their source without inventing a library signature',()=>{
  assert.equal(hover('import custom_package as cp\ncp.work(1)','work'),'custom_package.work\nReferenced through an import in this notebook');
});
test('multiline signatures, class docstrings and incomplete cells are supported',()=>{
  assert.match(hover('async def fetch(\n    url,\n    timeout=3\n):\n    """Fetch a result."""\n    pass\nfetch(','fetch'),/Fetch a result/);
  assert.match(hover('class Thing:\n    """A useful thing."""\n    pass\nThing()','Thing'),/A useful thing/);
  assert.match(hover('from pandas import (\n DataFrame as Frame,\n read_csv\n)\nFrame(','Frame'),/pandas.DataFrame/);
});
