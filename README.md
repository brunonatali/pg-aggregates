# @brunatali/pg-aggregates

Same pluging from `@graphile/pg-aggregates` incuding:

- Customizable time zone
- `Interval` type corrections
- `Interval` type new options (secondsInt, iso, isoShort and raw)

**Note.** ISO representations in the 8601 standard.

## @graphile/pg-aggregates

## [Click here to read original description from @graphile/pg-aggregates.](https://github.com/graphile/pg-aggregates)

## Usage

`timezone` is just applicable for `groupBy` item using column that represents
`time`, `date` or both.  
It's value must be entered as `string`, representing hour. Eg:

- '03'
- '11'
- '-04'
- '-10'

You can issue a GraphQL query such as:

```graphql
query GameAggregates {
  allPlayers {
    groupedAggregates(groupBy: CREATED_AT_TRUNCATED_TO_DAY, timezone: "03") {
      keys
      distinctCount {
        goals
      }
    }
  }
}
```

With interval corrections, now is perfectly possible to retrieve an average
field by issue this GraphQL query:

````graphql
query PlayersAggregates {
  allPlayers {
    groupedAggregates(groupBy: PLAYER_NAME) {
      average {
        gameTime {
          seconds
          secondsInt
          minutes
          hours
          days
          months
          years
          iso
          isoShort
          raw
        }
      }
    }
  }
}


### Environment variable

Is accepted to set a default time zone by placing `GROUP_BY_AGGREGATE_TIMEZONE`
to .env file.

```bash
GROUP_BY_AGGREGATE_TIMEZONE=-03
````

## Defining your own grouping derivatives

You may add your own derivatives by adding a group by spec to
`build.pgAggregateGroupBySpecs` via a plugin. Derivative specs are fairly
straightforward, for example here's the spec for "truncated-to-hour":

```ts
const DATE_OID = "1082";
const TIMESTAMP_OID = "1114";
const TIMESTAMPTZ_OID = "1184";

const truncatedToHourSpec = {
  // [IMPORTANT] This new feature require that sql builder knows the column
  // type during the process. Passing this to query builder will makes the engine
  // to add correct time zone formatter.
  isTimestampLike: true,

  // A unique identifier for this spec, will be used to generate its name:
  id: "truncated-to-hour",

  // A filter to determine which column/function return types this derivative
  // is valid against:
  isSuitableType: (pgType) =>
    pgType.id === DATE_OID ||
    pgType.id === TIMESTAMP_OID ||
    pgType.id === TIMESTAMPTZ_OID,

  // The actual derivative - given the SQL fragment `sqlFrag` which represents
  // the column/function call, return a new SQL fragment that represents the
  // derived value, in this case a truncated timestamp:
  sqlWrap: (sqlFrag) => sql.fragment`date_trunc('hour', ${sqlFrag})`,
};
```

Building that up with a few more different intervals into a full PostGraphile
plugin, you might write something like:

```ts
// Constants from PostgreSQL
const DATE_OID = "1082";
const TIMESTAMP_OID = "1114";
const TIMESTAMPTZ_OID = "1184";

// Produce an indexable list of date_trunc fields
// Other values: microseconds, milliseconds, second, minute, quarter,
// decade, century, millennium.
// See https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-TRUNC
const dateInterval = {
  year: {
    id: 1,
    name: "year",
  },
  month: {
    id: 2,
    name: "month",
  },
  week: {
    id: 3,
    name: "week",
  },
  day: {
    id: 4,
    name: "day",
  },
  hour: {
    id: 5,
    name: "hour",
  },
};

// Build a spec that truncates to the given interval
const tsTruncateSpec = (sql, interval) => ({
  id: `truncated-to-${interval}`,
  isSuitableType: (pgType) => {
    // Determine if a given type is a timestamp/timestamptz
    if (pgType.id === TIMESTAMP_OID || pgType.id === TIMESTAMPTZ_OID) {
      return true;
    }
    // Date type columns must not truncate to `day` or `hour`
    if (pgType.id === DATE_OID && interval.id <= dateInterval.week.id) {
      return true;
    }

    return false;
  },
  sqlWrap: (sqlFrag) =>
    sql.fragment`date_trunc(${sql.literal(interval)}, ${sqlFrag})`,
  isTimestampLike: true,
});

// This is the PostGraphile plugin; see:
// https://www.graphile.org/postgraphile/extending/
const DateTruncAggregateGroupSpecsPlugin = (builder) => {
  builder.hook("build", (build) => {
    const { pgSql: sql } = build;

    build.pgAggregateGroupBySpecs = [
      // Copy all existing specs, except the ones we're replacing
      ...build.pgAggregateGroupBySpecs.filter(
        (spec) => !["truncated-to-day", "truncated-to-hour"].includes(spec.id)
      ),

      // Add our timestamp specs
      ...Object.entries(dateInterval).map(([, dateField]) =>
        truncateBySpec(sql, dateField)
      ),
    ];

    return build;
  });
};
```
