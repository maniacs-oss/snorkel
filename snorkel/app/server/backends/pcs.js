"use strict";

var driver = require_app("server/backends/driver");
var context = require_core("server/context");

var child_process = require("child_process");
var backend = require_app("server/backend");

var path = require("path")
var cwd = process.cwd()

var DIGEST_PATH = path.join(cwd, "./bin/digest");
var INGEST_PATH = path.join(cwd, "./bin/ingest");
var QUERY_PATH = path.join(cwd, "./bin/query");
var DB_DIR = "./"
// TODO:
// implement weighting columns
// implement sort by
// implement sum/count metrics


function get_cmd(bin, arg_string) {
  return bin + " " + arg_string
}

function run_query_cmd(arg_string, cb) {
  var cmd = get_cmd(QUERY_PATH, arg_string)
  cb = context.wrap(cb)
  console.log("RUNNING COMMAND", cmd)
  child_process.exec(cmd, {
    cwd: DB_DIR,
    maxBuffer: 100000*1024
  }, function(err, stdout, stderr) {
    console.log(stderr)
    var parsed;
    try {
      parsed = JSON.parse(stdout)
    } catch(e) {

      cb("Error Parsing JSON", null)
      return
    }

    cb(err, parsed)
  })

}

function marshall_time_rows(time_buckets, cols, dims) {
  var ret = [];
  _.each(time_buckets, function(rows, time_bucket) {
    _.each(rows, function(r) {
      var row = {};
      row._id = {};
      _.each(dims, function(d) {
        row._id[d] = r[d];
      });

      _.each(cols, function(c) {
        row[c] = parseFloat(r[c], 10);
      });

      row._id.time_bucket = parseInt(time_bucket, 10);

      row.count = r.Count;

      ret.push(row);
    });

  });

  return ret;

}

function marshall_table_rows(rows, cols, dims) {
  var ret = [];
  _.each(rows, function(r) {
    var row = {};
    row._id = {};
    _.each(dims, function(d) {
      row._id[d] = r[d];
    });

    _.each(cols, function(c) {
      row[c] = parseFloat(r[c], 10);
    });

    row.count = r.Count;

    ret.push(row);
  });

  return ret;
}

function add_dims_and_cols(query_spec) {
  var cmd_args = "";
  if (!query_spec || !query_spec.opts || !query_spec.opts.dims) {
    return "";
  }

  if (query_spec.opts.dims.length) {
    var group_by = query_spec.opts.dims.join(",");
    cmd_args += " -group " + group_by + " ";
  }
  if (query_spec.opts.cols.length) {
    var int_by = query_spec.opts.cols.join(",");
    cmd_args += " -int " + int_by + " ";

  }

  return cmd_args;
}

function add_limit(query_spec) {

  if (query_spec.opts.limit) {
    return "-limit " + query_spec.opts.limit + " "
  }

  return ""
}

function get_args_for_spec(query_spec) {
  var cmd_args = "";
  if (!query_spec || !query_spec.opts) {
    return cmd_args;
  }
  
  cmd_args += " -laq ";
  cmd_args += add_dims_and_cols(query_spec);
  cmd_args += add_str_filters(query_spec);
  cmd_args += add_int_and_time_filters(query_spec);
  cmd_args += add_limit(query_spec);
  return cmd_args;
}

function marshall_dist_rows(rows, cols, dims) {
  var ret = [];
  _.each(rows, function(r) {
    var row = {};
    row._id = {};
    _.each(dims, function(d) {
      row._id[d] = r[d];
    });

    var col = cols[0];
    _.each(r[col], function(p) {
      var copy = _.clone(row);
      copy._id = _.clone(row._id);
      copy._id[col] = p;
      copy.count = parseFloat(r.Count) / parseFloat(r[col].length);

      ret.push(copy);
    });
  });

  return ret;


}


function run_hist_query(table, query_spec, cb) {
  var cmd_args = "-print -json -op hist";
  cmd_args += get_args_for_spec(query_spec);
  console.log("RUNNING DIST QUERY");

  run_query_cmd(cmd_args + " -table " + table, function(err, results) {
    var marshalled = marshall_dist_rows(results, query_spec.opts.cols, query_spec.opts.dims);
    cb(null, marshalled)
  })
}

function run_time_query(table, query_spec, cb) {
  var cmd_args = "-print -json -time ";

  cmd_args += "-time-bucket " + query_spec.opts.time_bucket;

  cmd_args += get_args_for_spec(query_spec);

  run_query_cmd(cmd_args + " -table " + table, function(err, results) {
    if (err) {
      return cb("Error parsing JSON");
    } 

    var marshalled = marshall_time_rows(results, query_spec.opts.cols, query_spec.opts.dims);
    cb(null, marshalled);

  })


}

function run_table_query(table, query_spec, cb) {
  var cmd_args = "-print -json"
  cmd_args += get_args_for_spec(query_spec)

  run_query_cmd(cmd_args + " -table " + table, function(err, results) {
    var marshalled = marshall_table_rows(results, query_spec.opts.cols, query_spec.opts.dims);
    cb(null, marshalled)

  })
}

function add_int_and_time_filters(query_spec) {
  if (!query_spec || !query_spec.opts) {
    return "";
  }

  var filters = []

  var tf = query_spec.meta.metadata.time_col || "time";

  if (query_spec.opts.start_ms) {
    filters.push(tf + ":gt:" + query_spec.opts.start_ms / 1000);
  } 

  if (query_spec.opts.end_ms) {
    filters.push(tf + ":lt:" + query_spec.opts.end_ms / 1000);
  }

  _.each(query_spec.opts.filters, function(f) {
    var tokens = f.column.split('.');
    if (tokens[0] !== "integer") {
      return
    }
    var column = tokens.slice(1).join('.');
    var value = f.conditions[0].value; //hardcoded for now

    filters.push(column + ':' + f.conditions[0].op.replace("$", "") + ':' + value);
  });


  var args = ""; 

  if (tf) {
    args = "-time-col " + tf + " ";
  }

  if (filters.length === 0) {
    return args;
  }

  return " -int-filter \"" + filters.join(",") + "\" " + args;
}

function add_str_filters(query_spec) {
  if (!query_spec || !query_spec.opts) {
    return "";
  }

  var filters = []

  _.each(query_spec.opts.filters, function(f) {
    var tokens = f.column.split('.');
    if (tokens[0] !== "string") {
      return
    }
    var column = tokens.slice(1).join('.');
    var op = "eq"; // hardcoded
    if (f.conditions[0].op != "$regex") {
      op = "neq"
    }

    var value = f.conditions[0].value; //hardcoded for now

    filters.push(column + ':' + op + ':' + value);
  });

  if (filters.length === 0) {
    return "";
  }

  return "-str-filter \"" + filters.join(",") + "\" ";
}

function run_samples_query(table, query_spec, cb) {
  if (!table) {
    return cb("No TABLE!", table)
  }

  var args = "";
  args += get_args_for_spec(query_spec)
  var table_name = table.table_name || table;
  run_query_cmd(args + " -samples -json -table " + table_name, function(err, samples) {
    var results = [];

    _.each(samples, function(sample) {
      var result = {
        integer: {},
        string: {}
      };

      _.each(sample, function(v, k) {
        try {
          var res = parseInt(v, 10);
          if (isNaN(res)) { throw "NaN"; }

          result.integer[k] = res;
          return;
        } catch (e)  { }

        result.string[k] = v;
      });

      results.push(result);

    });

    cb(null, results);
  })
}

var _cached_columns = {};
function get_cached_columns(table, cb) {
  if (!table) {
    return;
  }

  table = table.table_name || table
  if (_cached_columns[table]) {
    console.log("Using cached column results for", table);
    var cached_for = (Date.now() - _cached_columns[table].updated) / 1000;
    cb(_cached_columns[table].results);
    cb = function() { };
    if (cached_for < 60 * 10) {
      return;
    }
  }

  get_columns(table, cb);
}


var _pending = {};
function get_columns(table, cb) {
  if (!table) {
    return cb();
  }

  cb = context.wrap(cb)
  table = table.table_name || table;

  if (_pending[table]) {
    _pending[table].push(cb);
    return;
  }
  _pending[table] = [cb];

  console.log("GETTING COLUMNS", table)
  run_query_cmd("-info -json -table " + table, function(err, info) {
    var cols = []
    _.each(info.columns.ints, function(col) {
      cols.push({name: col, type_str: 'integer'});
    });

    _.each(info.columns.strs, function(col) {
      cols.push({name: col, type_str: 'string'});
    });

    _cached_columns[table] = {
      results: cols,
      updated: Date.now()
    };


    _.each(_pending[table], function(_cb) {
      _cb(cols);
    });

    delete _pending[table];
  });

}

var DIGESTIONS = {}
function queue_digest_records(table_name) {
  DIGESTIONS[table_name] = true
  digest_records();
}

var digest_records = _.throttle(function () {
  _.each(DIGESTIONS, function(val, table_name) {
    child_process.exec(DIGEST_PATH + " -table " + table_name, {
      cwd: DB_DIR,
    }, function(err, stdout, stderr) {
      console.log(stderr); 
    });
  });

  DIGESTIONS = {};
}, 30000, { leading: false });

var PCSDriver = _.extend(driver.Base, {
  run: function(table, query_spec, unweight, cb) {
    console.log("RUNNING QUERY", table, query_spec);
    if (!table) {
      return cb("Error TABLE", table, "is undefined")
    }

    if (backend.SAMPLE_VIEWS[query_spec.view]) {
      run_samples_query(table, query_spec, cb);
    }

    if (query_spec.view === 'table') {
      run_table_query(table, query_spec, cb);
    }

    if (query_spec.view === 'time') {
      run_time_query(table, query_spec, cb);
    }
    if (query_spec.view === 'hist') {
      run_hist_query(table, query_spec, cb);
    }
  },
  get_stats: function(table, cb) {
    console.log("GETTING STATS FOR TABLE", table)
    table = table.table_name || table
    // count: 3253,
    // size: 908848,
    // avgObjSize: 279.3876421764525,
    // storageSize: 1740800,
    run_query_cmd("-json -info -table " + table, function(err, info) {
      cb(info);
    });
  },
  get_tables: function(cb) {
    run_query_cmd("-tables -json",
      function(err, info) {
        var tables = [];
        _.each(info, function(table) {
          tables.push({ table_name: table });
        });

        cb(tables);
      });
  },
  get_columns: get_cached_columns,
  clear_cache: function(table, cb) {},
  drop_dataset: function(table, cb) {},
  default_table: "snorkel_test_data",
  add_samples: function(dataset, subset, samples, cb) {
    console.log("ADDING SAMPLES", dataset, subset, samples);
    var table_name = dataset + "." + subset;
    var cmd = get_cmd(INGEST_PATH, "-table " + table_name);
    cb = context.wrap(cb);
    console.log("RUNNING COMMAND", cmd);
    queue_digest_records(table_name);
    var cp = child_process.exec(cmd, {
      cwd: DB_DIR,
    });

    _.each(samples, function(s) {
      cp.stdin.write(JSON.stringify(s) + "\n");
    });
    cp.stdin.destroy();

    cb();


  }
});

module.exports = PCSDriver;