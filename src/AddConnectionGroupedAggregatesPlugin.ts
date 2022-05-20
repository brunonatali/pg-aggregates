import type { Plugin } from "graphile-build";
import type { SQL } from "graphile-build-pg";
import type {
  GraphQLResolveInfo,
  GraphQLEnumType,
  GraphQLObjectType,
} from "graphql";
import * as _ from "lodash";

import { TIMEZONE_TYPE, OurCustomQueryBuilder } from "./interfaces";

function isValidEnum(enumType: GraphQLEnumType): boolean {
  try {
    if (!enumType) {
      return false;
    }
    if (Object.keys(enumType.getValues()).length === 0) {
      return false;
    }
  } catch (e) {
    return false;
  }
  return true;
}

const AddConnectionGroupedAggregatesPlugin: Plugin = (builder) => {
  builder.hook("GraphQLObjectType:fields", (fields, build, context) => {
    const {
      graphql: { GraphQLList, GraphQLNonNull, GraphQLString },
      inflection,
      getSafeAliasFromResolveInfo,
      pgSql: sql,
      getSafeAliasFromAlias,
      pgQueryFromResolveData: queryFromResolveData,
    } = build;
    const {
      fieldWithHooks,
      scope: { isPgRowConnectionType, pgIntrospection: table },
    } = context;

    // If it's not a table connection, abort
    if (
      !isPgRowConnectionType ||
      !table ||
      table.kind !== "class" ||
      !table.namespace
    ) {
      return fields;
    }

    const AggregateContainerType:
      | GraphQLObjectType
      | undefined = build.getTypeByName(
      inflection.aggregateContainerType(table)
    );

    if (
      !AggregateContainerType ||
      Object.keys(AggregateContainerType.getFields()).length === 0
    ) {
      // No aggregates for this connection, abort
      return fields;
    }

    const fieldName = inflection.groupedAggregatesContainerField(table);
    const TableGroupByType = build.getTypeByName(
      inflection.aggregateGroupByType(table)
    );
    const TableHavingInputType = build.getTypeByName(
      inflection.aggregateHavingInputType(table)
    );
    const tableTypeName = inflection.tableType(table);
    if (!isValidEnum(TableGroupByType)) {
      return fields;
    }

    return {
      ...fields,
      [fieldName]: fieldWithHooks(
        fieldName,
        ({ addDataGenerator, getDataFromParsedResolveInfoFragment }: any) => {
          addDataGenerator((parsedResolveInfoFragment: any) => {
            const safeAlias = getSafeAliasFromAlias(
              parsedResolveInfoFragment.alias
            );
            const resolveData = getDataFromParsedResolveInfoFragment(
              parsedResolveInfoFragment,
              AggregateContainerType
            );
            return {
              // Push a query container
              pgNamedQueryContainer: {
                name: safeAlias,
                query: ({
                  queryBuilder,
                  innerQueryBuilder,
                  options,
                }: {
                  queryBuilder: OurCustomQueryBuilder;
                  innerQueryBuilder: OurCustomQueryBuilder;
                  options: any;
                }) => {
                  const args = parsedResolveInfoFragment.args;
                  const timezone: TIMEZONE_TYPE | null =
                    args.timezone ||
                    process.env.GROUP_BY_AGGREGATE_TIMEZONE ||
                    null;

                  const groupBy: Array<
                    Array<TemplateStringsArray>
                  > = args.groupBy.map((b: any) => [
                    // Camel case row name (tableColumnName)
                    sql.fragment`${sql.literal(inflection.camelCase(b.name))}`,
                    // Alias plus raw row name (__local_0__.table_column_name)
                    sql.fragment`${b.spec(
                      queryBuilder.getTableAlias(),
                      timezone
                    )}`,
                  ]);
                  const having: SQL | null = args.having
                    ? TableHavingInputType.extensions.graphile.toSql(
                        args.having,
                        { tableAlias: queryBuilder.getTableAlias() }
                      )
                    : null;
                  if (having && groupBy.length === 0) {
                    throw new Error(
                      "Must not provide having without also providing groupBy"
                    );
                  }

                  const isPaginationRequired =
                    options.withPagination ||
                    options.withPaginationAsFields ||
                    options.withCursor;
                  let limit: number | undefined;
                  let offset: number | undefined;
                  let flip: boolean | undefined;
                  let orderBy: Array<SQL> | undefined;

                  if (isPaginationRequired) {
                    const paginationConfig = queryBuilder.getFinalLimitAndOffset();
                    // To use case Cursor needs some customization
                    // const selectCursor = queryBuilder.getSelectCursor();
                    limit = paginationConfig.limit;
                    offset = paginationConfig.offset;
                    flip = paginationConfig.flip;

                    orderBy = queryBuilder
                      .getOrderByExpressionsAndDirections()
                      .map(([expr, ascending, nullsFirst]) => {
                        groupBy.push([
                          // We need to get just column name
                          // Need to test if have more than 3 items on this expression
                          sql.fragment`${sql.literal(
                            inflection.camelCase(expr[2].names[0])
                          )}`,
                          sql.fragment`${expr}`,
                        ]);
                        return sql.fragment`${expr} ${
                          Number(ascending) ^ Number(flip)
                            ? sql.fragment`ASC`
                            : sql.fragment`DESC`
                        }${
                          nullsFirst === true
                            ? sql.fragment` NULLS FIRST`
                            : nullsFirst === false
                            ? sql.fragment` NULLS LAST`
                            : null
                        }`;
                      });
                  }

                  innerQueryBuilder.select(
                    () =>
                      sql.fragment`json_build_object(${sql.join(
                        groupBy.map(
                          ([name, spec]: [
                            TemplateStringsArray,
                            TemplateStringsArray
                          ]) => sql.fragment`(${name})::text, (${spec})`
                        ),
                        ", "
                      )})`,
                    "keys"
                  );

                  return sql.fragment`\
coalesce((select json_agg(j.data) from (
  select ${innerQueryBuilder.build({ onlyJsonField: true })} as data
  from ${queryBuilder.getTableExpression()} as ${queryBuilder.getTableAlias()}
  where ${queryBuilder.buildWhereClause(false, false, options)}
  ${
    groupBy.length > 0
      ? sql.fragment`group by ${sql.join(
          // Get just table's original row name
          groupBy.map(([, col]) => col),
          ", "
        )}`
      : sql.blank
  }
  ${
    orderBy && orderBy.length
      ? sql.fragment`order by ${sql.join(orderBy, ", ")}`
      : ""
  }
  ${having ? sql.fragment`having ${having}` : sql.empty}
  ${_.isSafeInteger(limit) && sql.fragment`limit ${sql.literal(limit)}`}
  ${offset && sql.fragment`offset ${sql.literal(offset)}`}
) j), '[]'::json)`;
                },
              },
              // This tells the query planner that we want to add an aggregate
              pgNamedQuery: {
                name: safeAlias,
                query: (aggregateQueryBuilder: OurCustomQueryBuilder) => {
                  // TODO: aggregateQueryBuilder.groupBy();
                  // TODO: aggregateQueryBuilder.select();
                  aggregateQueryBuilder.select(() => {
                    const query = queryFromResolveData(
                      sql.identifier(Symbol()),
                      aggregateQueryBuilder.getTableAlias(), // Keep using our alias down the tree
                      resolveData,
                      { onlyJsonField: true },
                      (innerQueryBuilder: OurCustomQueryBuilder) => {
                        innerQueryBuilder.parentQueryBuilder = aggregateQueryBuilder;
                        innerQueryBuilder.select(
                          sql.fragment`sum(1)`,
                          "__force_aggregate__"
                        );
                      },
                      aggregateQueryBuilder.context
                    );
                    return sql.fragment`(${query})`;
                  }, safeAlias);
                },
              },
            };
          });

          return {
            description: `Grouped aggregates across the matching connection (ignoring before/after/first/last/offset)`,
            type: new GraphQLList(new GraphQLNonNull(AggregateContainerType)),
            args: {
              groupBy: {
                type: new GraphQLNonNull(
                  new GraphQLList(new GraphQLNonNull(TableGroupByType))
                ),
                description: build.wrapDescription(
                  `The method to use when grouping \`${tableTypeName}\` for these aggregates.`,
                  "arg"
                ),
              },
              timezone: {
                type: GraphQLString,
                description: build.wrapDescription(
                  `Use this to set time zone for date_trunc that accepts three different forms: Full time zone name; Time zone abbreviation; POSIX-style time zone specifications.`,
                  "arg"
                ),
              },
              ...(TableHavingInputType
                ? {
                    having: {
                      type: TableHavingInputType,
                      description: build.wrapDescription(
                        `Conditions on the grouped aggregates.`,
                        "arg"
                      ),
                    },
                  }
                : null),
            },
            resolve(
              parent: any,
              _args: any,
              _context: any,
              resolveInfo: GraphQLResolveInfo
            ) {
              const safeAlias = getSafeAliasFromResolveInfo(resolveInfo);
              return parent[safeAlias].map((entry: any) => ({
                /* Rewrite the object due to aliasing */
                ...entry[safeAlias],
                keys: entry.keys,
              }));
            },
          };
        },
        {}
      ),
    };
  });
};

export default AddConnectionGroupedAggregatesPlugin;
