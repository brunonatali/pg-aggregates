import type { Plugin } from "graphile-build";
import type {
  PgAttribute,
  QueryBuilder,
  PgProc,
  PgClass,
} from "graphile-build-pg";
import type { GraphQLResolveInfo, GraphQLFieldConfigMap } from "graphql";
import * as postgresParse from "postgres-interval";
import { AggregateSpec, PostgresIntervalInterface } from "./interfaces";

const AddAggregateTypesPlugin: Plugin = (builder) => {
  // Create the aggregates type for each table
  builder.hook("init", (init, build, _context) => {
    const {
      newWithHooks,
      graphql: {
        GraphQLObjectType,
        GraphQLList,
        GraphQLNonNull,
        GraphQLString,
      },
      inflection,
      pgIntrospectionResultsByKind,
      pgOmit: omit,
    } = build;

    pgIntrospectionResultsByKind.class.forEach((table: PgClass) => {
      if (!table.namespace) {
        return;
      }
      if (omit(table, "read")) {
        return;
      }
      if (table.tags.enum) {
        return;
      }
      if (!table.isSelectable) {
        return;
      }

      /* const AggregateContainerType = */
      newWithHooks(
        GraphQLObjectType,
        {
          name: inflection.aggregateContainerType(table),
          fields: {
            keys: {
              type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
              resolver(parent: any) {
                return parent.keys || [];
              },
            },
          },
        },
        {
          isPgAggregateContainerType: true,
          pgIntrospection: table,
        },
        true
      );
    });

    return init;
  });

  // Hook the '*Aggregates' type for each table to add the "sum" operation
  builder.hook(
    "GraphQLObjectType:fields",
    function addAggregateFieldsToAggregateType(fields, build, context) {
      const {
        pgField,
        inflection,
        newWithHooks,
        graphql: { GraphQLObjectType },
        getSafeAliasFromResolveInfo,
      } = build;
      const {
        fieldWithHooks,
        scope: { isPgAggregateContainerType, pgIntrospection: table },
      } = context;
      if (!isPgAggregateContainerType) {
        return fields;
      }

      return build.extend(
        fields,
        (build.pgAggregateSpecs as AggregateSpec[]).reduce(
          (memo: GraphQLFieldConfigMap<unknown, unknown>, spec) => {
            const AggregateType = newWithHooks(
              GraphQLObjectType,
              {
                name: inflection.aggregateType(table, spec),
              },
              {
                isPgAggregateType: true,
                pgAggregateSpec: spec,
                pgIntrospection: table,
              },
              true
            );

            if (!AggregateType) {
              // No aggregates for this connection for this spec, abort
              return memo;
            }
            const fieldName = inflection.aggregatesField(spec);
            return build.extend(memo, {
              ...fields,
              [fieldName]: pgField(
                build,
                fieldWithHooks,
                fieldName,
                {
                  description: `${spec.HumanLabel} aggregates across the matching connection (ignoring before/after/first/last/offset)`,
                  type: AggregateType,
                  resolve(
                    parent: any,
                    _args: any,
                    _context: any,
                    resolveInfo: GraphQLResolveInfo
                  ) {
                    const safeAlias = getSafeAliasFromResolveInfo(resolveInfo);
                    return parent[safeAlias];
                  },
                },
                {
                  isPgAggregateField: true,
                  pgAggregateSpec: spec,
                  pgFieldIntrospection: table,
                } // scope,
              ),
            });
          },
          {}
        )
      );
    }
  );

  // Hook the sum aggregates type to add fields for each numeric table column
  builder.hook("GraphQLObjectType:fields", (fields, build, context) => {
    const {
      pgSql: sql,
      newWithHooks,
      graphql: {
        GraphQLNonNull,
        GraphQLObjectType,
        GraphQLInt,
        GraphQLFloat,
        GraphQLString,
      },
      inflection,
      parseResolveInfo,
      getSafeAliasFromAlias,
      getSafeAliasFromResolveInfo,
      pgField,
      pgIntrospectionResultsByKind,
      pgGetComputedColumnDetails: getComputedColumnDetails,
    } = build;
    const {
      fieldWithHooks,
      scope: {
        isPgAggregateType,
        pgIntrospection: table,
        pgAggregateSpec: spec,
      },
    } = context;
    if (!isPgAggregateType || !table || table.kind !== "class" || !spec) {
      return fields;
    }

    return {
      ...fields,
      // Figure out the columns that we're allowed to do a `SUM(...)` of
      ...table.attributes.reduce(
        (memo: GraphQLFieldConfigMap<any, any>, attr: PgAttribute) => {
          if (
            (spec.shouldApplyToEntity && !spec.shouldApplyToEntity(attr)) ||
            !spec.isSuitableType(attr.type)
          ) {
            return memo;
          }
          const [pgType, pgTypeModifier] = spec.pgTypeAndModifierModifier
            ? spec.pgTypeAndModifierModifier(attr.type, attr.typeModifier)
            : [attr.type, attr.typeModifier];
          let Type = build.pgGetGqlTypeByTypeIdAndModifier(
            pgType.id,
            pgTypeModifier
          );
          if (!Type) {
            return memo;
          }

          /**
           * This will (re)produce standard Interval fields plus some
           * customs formats
           * @note Standard GraphQL types taken from
           * https://github.com/graphql-java/graphql-java/tree/master/src/main/java/graphql/schema
           * Types documentation at https://graphql.org/learn/schema/
           */
          const makeIntervalFields = () => {
            return {
              seconds: {
                description: build.wrapDescription(
                  "A quantity of seconds. This is the only non-integer field, as all the other fields will dump their overflow into a smaller unit of time. Intervals don’t have a smaller unit than seconds.",
                  "field"
                ),
                type: GraphQLFloat,
              },
              // To maintain compatibility, will create `secondsInt`, which applies parseInt()
              secondsInt: {
                description: build.wrapDescription(
                  "A quantity of seconds. This is the only non-integer field, as all the other fields will dump their overflow into a smaller unit of time. Intervals don’t have a smaller unit than seconds.",
                  "field"
                ),
                type: GraphQLInt,
              },
              minutes: {
                description: build.wrapDescription(
                  "A quantity of minutes.",
                  "field"
                ),
                type: GraphQLInt,
              },
              hours: {
                description: build.wrapDescription(
                  "A quantity of hours.",
                  "field"
                ),
                type: GraphQLInt,
              },
              days: {
                description: build.wrapDescription(
                  "A quantity of days.",
                  "field"
                ),
                type: GraphQLInt,
              },
              months: {
                description: build.wrapDescription(
                  "A quantity of months.",
                  "field"
                ),
                type: GraphQLInt,
              },
              years: {
                description: build.wrapDescription(
                  "A quantity of years.",
                  "field"
                ),
                type: GraphQLInt,
              },
              iso: {
                description: build.wrapDescription(
                  "A ISO 8601 representation.",
                  "field"
                ),
                type: GraphQLString,
              },
              isoShort: {
                description: build.wrapDescription(
                  "A ISO 8601 Short representation.",
                  "field"
                ),
                type: GraphQLString,
              },
              raw: {
                description: build.wrapDescription(
                  "Exactly the same result.",
                  "field"
                ),
                type: GraphQLString,
              },
            };
          };

          const fieldName = inflection.column(attr);

          /**
           * Lets recreate standard GraphQL Interval type
           * Here we will extend to add iso, isoShort and secondsInt
           */
          let intervalTypeName: string;
          if (Type.toString() === "Interval") {
            /**
             * Like:
             *  - AggrMyTableNameAverageAggregatesMyColumnNameIntervalType
             *  - AggrMyTableNameSumAggregatesMyColumnNameIntervalType
             */
            intervalTypeName = `${inflection.aggregateType(table, spec)}${
              fieldName.charAt(0).toUpperCase() + fieldName.slice(1)
            }TypeInterval`;
            Type = newWithHooks(
              GraphQLObjectType,
              {
                name: intervalTypeName,
                description: build.wrapDescription(
                  "An interval of time that has passed where the smallest distinct unit is a second.",
                  "type"
                ),
                fields: makeIntervalFields(),
              },
              {
                isIntervalType: true,
              }
            );
          }

          return build.extend(memo, {
            [fieldName]: pgField(
              build,
              fieldWithHooks,
              fieldName,
              ({ addDataGenerator }: any) => {
                addDataGenerator((parsedResolveInfoFragment: any) => {
                  return {
                    pgQuery: (queryBuilder: QueryBuilder) => {
                      // Note this expression is just an sql fragment, so you
                      // could add CASE statements, function calls, or whatever
                      // you need here
                      const sqlColumn = sql.fragment`${queryBuilder.getTableAlias()}.${sql.identifier(
                        attr.name
                      )}`;
                      const sqlAggregate = spec.sqlAggregateWrap(sqlColumn);
                      queryBuilder.select(
                        sqlAggregate,
                        // We need a unique alias that we can later reference in the resolver
                        getSafeAliasFromAlias(parsedResolveInfoFragment.alias)
                      );
                    },
                  };
                });
                return {
                  description: `${spec.HumanLabel} of ${fieldName} across the matching connection`,
                  type: spec.isNonNull ? new GraphQLNonNull(Type) : Type,
                  resolve: !intervalTypeName
                    ? (
                        parent: any,
                        _args: any,
                        _context: any,
                        resolveInfo: GraphQLResolveInfo
                      ) => parent[getSafeAliasFromResolveInfo(resolveInfo)]
                    : (
                        parent: any,
                        _args: any,
                        _context: any,
                        resolveInfo: GraphQLResolveInfo
                      ) => {
                        const safeAlias = getSafeAliasFromResolveInfo(
                          resolveInfo
                        );

                        if (typeof parent[safeAlias] === "string") {
                          const requestFieldsInfo =
                            parseResolveInfo(resolveInfo) || {};
                          if (
                            requestFieldsInfo.fieldsByTypeName &&
                            requestFieldsInfo.fieldsByTypeName[intervalTypeName]
                          ) {
                            const mappedReturn = {};

                            const getParsedIntervalReturn = (
                              timeName: string
                            ) => {
                              switch (timeName) {
                                case "iso":
                                  return postgresParse(
                                    parent[safeAlias]
                                  ).toISOString();

                                case "isoShort":
                                  return postgresParse(
                                    parent[safeAlias]
                                  ).toISOStringShort();

                                case "seconds":
                                  return parseFloat(
                                    parent[safeAlias].split(":")[2]
                                  );

                                case "secondsInt":
                                  return postgresParse(parent[safeAlias])
                                    .seconds;

                                case "raw":
                                  return parent[safeAlias];

                                default:
                                  return postgresParse(parent[safeAlias])[
                                    timeName
                                  ];
                              }
                            };

                            Object.entries(
                              requestFieldsInfo.fieldsByTypeName[
                                intervalTypeName
                              ]
                            ).forEach(
                              ([, time]: [any, PostgresIntervalInterface]) => {
                                mappedReturn[
                                  time.name
                                ] = getParsedIntervalReturn(time.name);
                              }
                            );

                            return mappedReturn;
                          }
                        }

                        return parent[safeAlias];
                      },
                };
              },
              {
                // In case anyone wants to hook us, describe ourselves
                isPgConnectionAggregateField: true,
                pgFieldIntrospection: attr,
              },
              false,
              {
                pgType,
                pgTypeModifier,
              }
            ),
          });
        },
        {}
      ),
      ...pgIntrospectionResultsByKind.procedure.reduce(
        (memo: GraphQLFieldConfigMap<any, any>, proc: PgProc) => {
          if (proc.returnsSet) {
            return memo;
          }
          const type = pgIntrospectionResultsByKind.typeById[proc.returnTypeId];
          if (
            (spec.shouldApplyToEntity && !spec.shouldApplyToEntity(proc)) ||
            !spec.isSuitableType(type)
          ) {
            return memo;
          }
          const computedColumnDetails = getComputedColumnDetails(
            build,
            table,
            proc
          );
          if (!computedColumnDetails) {
            return memo;
          }
          const { pseudoColumnName } = computedColumnDetails;
          const fieldName = inflection.computedColumn(
            pseudoColumnName,
            proc,
            table
          );
          return build.extend(memo, {
            [fieldName]: build.pgMakeProcField(fieldName, proc, build, {
              fieldWithHooks,
              computed: true,
              aggregateWrapper: spec.sqlAggregateWrap,
              pgTypeAndModifierModifier: spec.pgTypeAndModifierModifier,
              description: `${
                spec.HumanLabel
              } of this field across the matching connection.${
                proc.description ? `\n\n---\n\n${proc.description}` : ""
              }`,
            }),
          });
        },
        {}
      ),
    };
  });
};

export default AddAggregateTypesPlugin;
