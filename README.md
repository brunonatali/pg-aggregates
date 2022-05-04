# @brunatali/pg-aggregates

Same pluging from `@graphile/pg-aggregates` incuding changable time zone.

## @graphile/pg-aggregates

## [Click here to read original description from @graphile/pg-aggregates.](https://github.com/graphile/pg-aggregates)

## Usage

`timezone` is applicable just for `groupBy` using column that represents `time`,
`date` or both.  
It's value must be entered as `string`, representing hour. Eg:

- '03'
- '11'
- '-4'
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

### Environment variable

Is accepted to set a default time zone by placing `GROUP_BY_AGGREGATE_TIMEZONE`
to .env file.

```bash
GROUP_BY_AGGREGATE_TIMEZONE=-03
```
