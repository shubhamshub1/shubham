import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'node:path';
import { importXmlFile, inspectXmlFile, deleteVouchers } from './tally.mjs';
import { escapeDoubleQuotesTDL, deleteMasters, fetchReport, importMastersTransactions, invokeTallyAction, queryCollection, renameObjectArrayProperties, validateVoucherTypeParent, validateLedgers, validateVoucherDebitCreditBalancing, stripExtraDecimalVoucherAmount } from './tally.mjs';
import { cacheTable, executeSQL } from './database.mjs';
import { lstCollectionFields, lstOptionCountryState } from './definition.mjs';
import { utility } from './utility.mjs';
dotenv.config({ override: true, quiet: true });
const isWriteBlocked = process.env.BLOCK_WRITE === '1';
const lstCollections = lstCollectionFields.map((item) => item.collection);
export async function registerMcpServer() {
    const mcpServer = new McpServer({
        name: 'Tally Prime MCP Server',
        title: 'Tally Prime',
        version: '7.12.2-aetherwise'
    });
    mcpServer.registerTool('metadata-collection', {
        title: 'Metadata Collection',
        description: 'returns collections metadata with collection and description',
        inputSchema: {},
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async () => {
        const collections = lstCollectionFields.map(({ collection, description }) => ({
            collection,
            description
        }));
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(collections)
                }
            ]
        };
    });
    mcpServer.registerTool('metadata-fields', {
        title: 'Metadata Fields',
        description: 'returns fields metadata for the selected tally collection containing field name, optional description and data type which can be string, number, date or boolean',
        inputSchema: {
            collection: z.enum(lstCollections).describe('target collection to fetch field metadata')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        const fields = (lstCollectionFields.find((item) => item.collection === args.collection)?.fields ?? []).map((field) => {
            const lstFields = { ...field };
            // substitute amount, quantity and rate data types with number data type to make it more generic since these are all numeric fields
            if (lstFields.datatype === 'amount' || lstFields.datatype === 'quantity' || lstFields.datatype === 'rate') {
                lstFields.datatype = 'number';
            }
            // delete property expression from field if found
            if (lstFields.expression) {
                delete lstFields.expression;
            }
            return lstFields;
        });
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(fields)
                }
            ]
        };
    });
    mcpServer.registerTool('query-option-values', {
        title: 'Query Option Values',
        description: 'returns predefined option values or drop-down values for the fields required for master and voucher creation, it returns back object array of pre-defined values',
        inputSchema: {
            optionName: z.enum(['country-state']).describe('option name to query')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        let retval = undefined;
        if (args.optionName === 'country-state')
            retval = lstOptionCountryState;
        else {
            return {
                isError: true,
                content: [
                    {
                        type: 'text',
                        text: 'Invalid option name'
                    }
                ]
            };
        }
        ;
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(retval)
                }
            ]
        };
    });
    mcpServer.registerTool('query-database', {
        title: 'Query Database',
        description: `executes sql query on pglite postgres in-memory database for querying cached Tally Prime report data in table generated as output by other tools (in tableID property from tool output response). These tables are temporary and will be dropped after 15 minutes automatically. Use this tool to run complex analytical queries to aggregate, filter, sort results`,
        inputSchema: {
            sql: z.string().describe('SQL query to execute on pglite postgres in-memory database, only SELECT queries are allowed. UPDATE, DELETE, INSERT queries are not allowed for data safety'),
            outputFormat: z.enum(['JSON Array of Objects', 'JSON with Schema and Rows', 'CSV', 'Markdown Table']).optional().describe('optional output format, default is JSON Array of Objects. JSON Array of Objects = [{"column1": "value1", "column2": "value2"}, {...}] , JSON with Schema and Rows = {"schema": ["column1", "column2"], "rows": [["value1", "value2"], [...]]}, CSV = comma separated values with header, Markdown Table = table format with header in markdown syntax which can be directly rendered in markdown supported viewers')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        const resp = await executeSQL(args.sql, args.outputFormat || 'JSON Array of Objects');
        return {
            content: [{ type: 'text', text: resp }]
        };
    });
    mcpServer.registerTool('query-collection', {
        title: 'Query Collection',
        description: `queries a Tally Prime collection with selected fields and optional context like target company and reporting period. result is cached in pglite postgres in-memory table and returned as tableID. Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            collection: z.enum(lstCollections).describe('collection name to query, validate it using metadata-collection tool with exact collection name'),
            fields: z.array(z.string()).min(1).describe('list of field names to fetch for the selected collection. validate it using metadata-fields resource for that collection'),
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose default company. validate it using list-master tool with collection as company if specified'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('optional from date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('optional to date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            const collection = args.collection.trim();
            const requestedFields = args.fields.map((field) => field.trim());
            const targetCollectionFields = lstCollectionFields.filter(p => p.collection == args.collection).map(p => p.fields)[0];
            // Validate that every requested field exists in the collection definition
            const validFieldNames = targetCollectionFields.map(f => f.name);
            const invalidFields = requestedFields.filter(f => !validFieldNames.includes(f));
            if (invalidFields.length > 0) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `The following fields do not exist in collection '${collection}': ${invalidFields.join(', ')}. Use metadata-fields resource to get valid field names.` }]
                };
            }
            const requestedFieldsMetadata = targetCollectionFields.filter(p => requestedFields.includes(p.name));
            const fromDate = args.fromDate ? new Date(args.fromDate) : undefined;
            const toDate = args.toDate ? new Date(args.toDate) : undefined;
            const result = await queryCollection(collection, requestedFields, new Map(), args.targetCompany, fromDate, toDate);
            // prepare Map of field name and data type for caching table metadata
            let fieldMetadataMap = new Map();
            requestedFieldsMetadata.forEach((field) => {
                if (field.datatype === 'amount' || field.datatype === 'quantity' || field.datatype === 'rate') {
                    fieldMetadataMap.set(field.name, 'number');
                }
                else if (field.datatype === 'date') {
                    fieldMetadataMap.set(field.name, 'date');
                }
                else if (field.datatype === 'boolean') {
                    fieldMetadataMap.set(field.name, 'boolean');
                }
                else {
                    fieldMetadataMap.set(field.name, 'string');
                }
            });
            const tableId = await cacheTable(fieldMetadataMap, result);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('list-master', {
        title: 'List Masters',
        description: `fetches list of masters from Tally Prime collection e.g. group, ledger, vouchertype, unit, godown, stockgroup, stockitem, costcategory, costcentre, attendancetype, company, currency, gstin, gstclassification returns output in JSON string array in the property list`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            collection: z.enum(['group', 'ledger', 'vouchertype', 'unit', 'godown', 'stockgroup', 'stockitem', 'costcategory', 'costcentre', 'attendancetype', 'company', 'currency', 'gstin', 'gstclassification']),
            containsFilter: z.string().optional().describe('optional filter to apply on name field with contains operator to filter results with respective name value or keywords, case insensitive')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let targetCollection = lstCollections.find((item) => item.toLowerCase() === args.collection.toLowerCase());
            if (!targetCollection) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'Invalid collection name' }]
                };
            }
            let lstFilters = new Map();
            if (args.containsFilter) {
                lstFilters.set('Search_Contains', `$Name CONTAINS "${args.containsFilter.replace(/"/g, '')}"`); //ensure to strip double quotes from filter value to avoid TDL syntax error
            }
            let result = await queryCollection(targetCollection, ['Name'], lstFilters, args.targetCompany);
            return {
                content: [{ type: 'text', text: JSON.stringify({ list: result.map((item) => item.Name) }) }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('chart-of-accounts', {
        title: 'Chart of Accounts',
        description: `fetches chart of accounts or GL hierarchy with fields ledger_name, group_name, primary_group, bs_pl, dr_cr, affects_gross_profit, sort_position. the column bs_pl will have values false = Balance Sheet / true = Profit Loss. Column dr_cr as value true = Debit / false = Credit. primary_group is the primary group of parent or group, under which ledger is nested. The columns group and parent are tree structure represented in flat format. The column affects_gross_profit has values true / false, it is used to determine if ledger under this group will affect gross profit or not. sort_position determines position or placement order with respect to items of same level for display, returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let result = await queryCollection('Ledger', ['Name', 'Parent', '_PrimaryGroup', 'IsRevenue', 'IsDeemedPositive', 'AffectsGrossProfit', 'SortPosition'], new Map(), args.targetCompany);
            result = renameObjectArrayProperties(result, new Map([['Name', 'ledger_name'], ['Parent', 'group_name'], ['_PrimaryGroup', 'primary_group'], ['IsRevenue', 'bs_pl'], ['IsDeemedPositive', 'dr_cr'], ['AffectsGrossProfit', 'affects_gross_profit'], ['SortPosition', 'sort_position']]));
            let tableID = await cacheTable(new Map([['ledger_name', 'string'], ['group_name', 'string'], ['primary_group', 'string'], ['bs_pl', 'boolean'], ['dr_cr', 'boolean'], ['affects_gross_profit', 'boolean'], ['sort_position', 'number']]), result);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('trial-balance', {
        title: 'Trial Balance',
        description: `fetches trial balance with fields ledger_name, group_name (blank if Profit & Loss), opening_balance, net_debit, net_credit, closing_balance. opening_balance and closing_balance negative is debit and positive is credit. kindly fetch data from chart-of-accounts tool to pull group hierarchy before calling this tool. returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('from or start date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('to or end date'),
            group_name: z.string().optional().describe('optional group name to filter trial balance results, validate it using list-master tool with collection as group if required')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let lstFilters = new Map();
            if (args.group_name) {
                lstFilters.set('Specific_Group', `$$IsEqual:$Parent:${escapeDoubleQuotesTDL(args.group_name)}`);
            }
            let result = await queryCollection('Ledger', ['Name', 'Parent', 'OpeningBalance', 'DebitTotals', 'CreditTotals', 'ClosingBalance'], lstFilters, args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
            result = renameObjectArrayProperties(result, new Map([['Name', 'ledger_name'], ['Parent', 'group_name'], ['OpeningBalance', 'opening_balance'], ['DebitTotals', 'net_debit'], ['CreditTotals', 'net_credit'], ['ClosingBalance', 'closing_balance']]));
            let tableID = await cacheTable(new Map([['ledger_name', 'string'], ['group_name', 'string'], ['opening_balance', 'amount'], ['net_debit', 'amount'], ['net_credit', 'amount'], ['closing_balance', 'amount']]), result);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('profit-loss', {
        title: 'Profit and Loss',
        description: `fetches profit and loss statement with fields like ledger_name, group_name, closing_balance. closing_balance negative is debit or expense and positive is credit or income. closing stock to be treated as credit, kindly fetch data from chart-of-accounts tool to pull group hierarchy before calling this tool. for detailed ledger level analysis call trial-balance tool, returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('from or start date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('to or end date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let result = [];
            // ledger rows
            let result_ledger = await queryCollection('Ledger', ['Name', 'Parent', 'ClosingBalance'], new Map([['PL_Group', '$IsRevenue']]), args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
            result_ledger = renameObjectArrayProperties(result_ledger, new Map([['Name', 'ledger_name'], ['Parent', 'group_name'], ['ClosingBalance', 'closing_balance']]));
            // opening and closing stock row
            let result_stock = await queryCollection('Group', ['Name', 'OpeningBalance', 'ClosingBalance'], new Map([['StockTypeGroup', '$$IsEqual:$Name:"Stock-in-Hand"']]), args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
            if (result_stock.length > 0) {
                result.push({
                    ledger_name: 'Opening Stock',
                    group_name: 'Stock-in-Hand',
                    closing_balance: result_stock[0].OpeningBalance
                });
                result.push({
                    ledger_name: 'Closing Stock',
                    group_name: 'Stock-in-Hand',
                    closing_balance: -result_stock[0].ClosingBalance
                });
            }
            // merge ledger and stock results
            result.push(...result_ledger);
            let tableID = await cacheTable(new Map([['ledger_name', 'string'], ['group_name', 'string'], ['closing_balance', 'amount']]), result);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('balance-sheet', {
        title: 'Balance Sheet',
        description: `fetches balance sheet with fields like ledger_name, group_name (blank if Profit & Loss A/c), closing_balance. closing balance negative is debit or asset and positive is credit or liability. kindly fetch data from chart-of-accounts tool to pull group hierarchy before calling this tool. returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period start or from date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period end or to date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let result = [];
            // ledger rows
            let result_ledger = await queryCollection('Ledger', ['Name', 'Parent', 'ClosingBalance'], new Map([['BS_Group', 'NOT $IsRevenue'], ['Excl_Stock', 'NOT $$IsGroupStock']]), args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
            result_ledger = renameObjectArrayProperties(result_ledger, new Map([['Name', 'ledger_name'], ['Parent', 'group_name'], ['ClosingBalance', 'closing_balance']]));
            result.push(...result_ledger);
            // closing stock row
            let result_stock = await queryCollection('Group', ['Name', 'ClosingBalance'], new Map([['StockTypeGroup', '$$IsEqual:$Name:"Stock-in-Hand"']]), args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
            if (result_stock.length > 0) {
                result.push({
                    ledger_name: 'Closing Stock',
                    group_name: 'Stock-in-Hand',
                    closing_balance: result_stock[0].ClosingBalance
                });
            }
            // profit loss row
            let result_pl = await queryCollection('Ledger', ['ClosingBalance'], new Map([['PL_Ledger', '$$IsEqual:$Name:"Profit & Loss A/c"']]), args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
            if (result_pl.length > 0) {
                result.push({
                    ledger_name: 'Profit & Loss A/c',
                    group_name: '',
                    closing_balance: result_pl[0].ClosingBalance
                });
            }
            let tableID = await cacheTable(new Map([['ledger_name', 'string'], ['group_name', 'string'], ['closing_balance', 'amount']]), result);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('stock-summary', {
        title: 'Stock Summary',
        description: `fetches stock item summary with fields stock_item_name, stock_group_name, opening_quantity, opening_value, inward_quantity, inward_value, outward_quantity, outward_value, closing_quantity, closing_value, returns output cached in pglite postgres in-memory table (specified in tableID property). synonyms (name=stock item / parent=stock group) Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period start or from date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period end or to date'),
            stockGroup: z.string().optional().describe('optional stock group name to filter stock summary results, validate it using list-master tool with collection as stock group if required')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let lstFilters = new Map();
            if (args.stockGroup) {
                lstFilters.set('Specific_StockGroup', `$$IsEqual:$Parent:${escapeDoubleQuotesTDL(args.stockGroup)}`);
            }
            let result = await queryCollection('StockItem', ['Name', 'Parent', 'OpeningBalance', 'OpeningValue', 'InwardQuantity', 'InwardValue', 'OutwardQuantity', 'OutwardValue', 'ClosingBalance', 'ClosingValue', 'AffectsGrossProfit', 'SortPosition'], lstFilters, args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
            result = renameObjectArrayProperties(result, new Map([['Name', 'stock_item_name'], ['Parent', 'stock_group_name'], ['OpeningBalance', 'opening_quantity'], ['OpeningValue', 'opening_value'], ['InwardQuantity', 'inward_quantity'], ['InwardValue', 'inward_value'], ['OutwardQuantity', 'outward_quantity'], ['OutwardValue', 'outward_value'], ['ClosingBalance', 'closing_quantity'], ['ClosingValue', 'closing_value']]));
            let tableID = await cacheTable(new Map([['stock_item_name', 'string'], ['stock_group_name', 'string'], ['opening_quantity', 'number'], ['opening_value', 'number'], ['inward_quantity', 'number'], ['inward_value', 'number'], ['outward_quantity', 'number'], ['outward_value', 'number'], ['closing_quantity', 'number'], ['closing_value', 'number']]), result);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('ledger-balance', {
        title: 'Ledger Balance',
        description: `fetches ledger closing balance as on date, negative is debit and positive is credit, display Dr for Debit or Cr for Credit after the amount for better readability, instead of negative amount flip Debit or Credit to make it positive`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            ledgerName: z.string().describe('precise ledger name, always validate it using list-master tool with collection as ledger'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('as on date for which balance is required')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let lstFilters = new Map([['Exact_Ledger', `$$IsEqual:$Name:${escapeDoubleQuotesTDL(args.ledgerName)}`]]);
            let result = await queryCollection('Ledger', ['ClosingBalance'], lstFilters, args.targetCompany, undefined, new Date(args.toDate));
            if (result.length > 0) {
                return { content: [{ type: 'text', text: JSON.stringify({ amount: result[0].ClosingBalance }) }] };
            }
            else {
                return { isError: true, content: [{ type: 'text', text: 'No ledger found' }] };
            }
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('stock-item-balance', {
        title: 'Stock Item Balance',
        description: `fetches stock item remaining quantity balance as on date, tool returns quantity and unit of measurement`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            itemName: z.string().describe('precise stock item name, always validate it using list-master tool with collection as stockitem'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('as on date for which balance is required')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let lstFilters = new Map([['Exact_StockItem', `$$IsEqual:$Name:${escapeDoubleQuotesTDL(args.itemName)}`]]);
            let result = await queryCollection('StockItem', ['ClosingBalance', 'Unit'], lstFilters, args.targetCompany, undefined, new Date(args.toDate));
            return {
                content: [{ type: 'text', text: JSON.stringify(result.length ? { quantity: result[0].ClosingBalance, unit_of_measurement: result[0].Unit } : '') }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('bills-outstanding', {
        title: 'Bills Outstanding',
        description: `fetches pending overdue outstanding bills receivable or payable as on date with fields bill_date,reference_number,outstanding_amount,party_name,overdue_days. outstanding_amount = Debit is negative and Credit is positive. party_name = ledger_name. returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            nature: z.enum(['receivable', 'payable']),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('as on date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let lstFilters = new Map();
            if (args.nature) {
                lstFilters.set('Nature', `$$IsEqual:($_PrimaryGroup:Group:($Parent:Ledger:$Parent)):"${args.nature === 'receivable' ? 'Sundry Debtors' : 'Sundry Creditors'}"`);
            }
            let result = await queryCollection('Bill', ['BillDate', 'Name', 'ClosingBalance', 'Parent', '_OverDueDays'], lstFilters, args.targetCompany, undefined, new Date(args.toDate));
            result = renameObjectArrayProperties(result, new Map([['BillDate', 'bill_date'], ['Name', 'reference_number'], ['ClosingBalance', 'outstanding_amount'], ['Parent', 'party_name'], ['_OverDueDays', 'overdue_days']]));
            let tableID = await cacheTable(new Map([['bill_date', 'date'], ['reference_number', 'string'], ['outstanding_amount', 'number'], ['party_name', 'string'], ['overdue_days', 'number']]), result);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('ledger-account', {
        title: 'Ledger Account',
        description: `fetches GL ledger account statement with voucher level details containing fields guid, date, voucher_type, voucher_number, alternate_ledger, party_name, amount, narration . amount = debit is negative and credit is positive. alternate_ledger = if amount is credit then ledger by which it is debited and vice-a-versa (in case of multiple ledgers first one is displayed). returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            ledgerName: z.string().describe('ledger name, always verify if ledger exists using list-master tool with collection as ledger'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('from or start date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('to or end date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate], ['ledgerName', args.ledgerName]]);
        if (args.targetCompany) {
            inputParams.set('targetCompany', args.targetCompany);
        }
        // verify if ledger exists before making report call to avoid unnecessary processing and load on Tally
        let lstLedger = await queryCollection('Ledger', ['Name'], new Map([['Exact_Ledger', `$$IsEqual:$Name:${escapeDoubleQuotesTDL(args.ledgerName)}`]]), args.targetCompany);
        if (lstLedger.length === 0) {
            return {
                isError: true,
                content: [{ type: 'text', text: 'No ledger found with the given name' }]
            };
        }
        const resp = await fetchReport('ledger-account', inputParams);
        if (resp.error) {
            return {
                isError: true,
                content: [{ type: 'text', text: resp.error }]
            };
        }
        else {
            //swap opening balance row to the top since it came at the end from Tally XML response
            if (Array.isArray(resp.data) && resp.data.length > 0) {
                const lastItem = resp.data.pop();
                resp.data.unshift(lastItem);
            }
            const tableId = await cacheTable(new Map([['guid', 'string'], ['date', 'date'], ['voucher_type', 'string'], ['voucher_number', 'string'], ['alternate_ledger', 'string'], ['party_name', 'string'], ['amount', 'number'], ['narration', 'string']]), resp.data);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
            };
        }
    });
    mcpServer.registerTool('stock-item-account', {
        title: 'Stock Item Account',
        description: `fetches GL stock item account statement with voucher level details containing fields date, voucher_type, voucher_number, party_name, quantity, amount, narration, tracking_number, voucher_category. party_name = ledger_name. quantity = inward as positive and outward as negative. amount = debit is negative and credit is positive, narration = notes / remarks. for calculating closing balance of quantity, consider rows with tracking_number as empty as it is, but for rows with tracking_number having text value, then duplicate rows need to be removed by preparing intermediate output with aggregation of tracking_number and voucher_category with sum of quantity and then comparing quantity of Receipt Note with Purchase and Delivery Note with Sales to identify and remove the rows with Receipt Note and Delivery Note if they are found to be tracked fully / partially . returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            itemName: z.string().describe('stock item name, validate it using list-master tool with collection as stockitem'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('from or start date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('to or end date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate], ['itemName', args.itemName]]);
        if (args.targetCompany) {
            inputParams.set('targetCompany', args.targetCompany);
        }
        // verify if stock item exists before making report call to avoid unnecessary processing and load on Tally
        let lstStockItem = await queryCollection('StockItem', ['Name'], new Map([['Exact_StockItem', `$$IsEqual:$Name:${escapeDoubleQuotesTDL(args.itemName)}`]]), args.targetCompany);
        if (lstStockItem.length === 0) {
            return {
                isError: true,
                content: [{ type: 'text', text: 'No stock item found with the given name' }]
            };
        }
        const resp = await fetchReport('stock-item-account', inputParams);
        if (resp.error) {
            return {
                isError: true,
                content: [{ type: 'text', text: resp.error }]
            };
        }
        else {
            //swap opening balance row to the top since it came at the end from Tally XML response
            if (Array.isArray(resp.data) && resp.data.length > 0) {
                const lastItem = resp.data.pop();
                resp.data.unshift(lastItem);
            }
            const tableId = await cacheTable(new Map([['date', 'date'], ['voucher_type', 'string'], ['voucher_number', 'string'], ['party_ledger', 'string'], ['quantity', 'number'], ['amount', 'number'], ['narration', 'string'], ['tracking_number', 'string'], ['voucher_category', 'string']]), resp.data);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
            };
        }
    });
    mcpServer.registerTool('set-company', {
        title: 'Set Company',
        description: `sets the active company context in Tally Prime. This changes the global company context used by Tally for subsequent operations and report queries`,
        inputSchema: {
            companyName: z.string().describe('company name to set as active, validate it using list-master tool with collection as company')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let inputParams = new Map([['SVCurrentCompany', utility.String.escapeHTML(args.companyName)]]);
            await invokeTallyAction('ChangeCurrentCompany', inputParams);
            return { content: [{ type: 'text', text: JSON.stringify('OK') }] };
        }
        catch (err) {
            return {
                isError: true, content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('set-period', {
        title: 'Set Period',
        description: `sets the active reporting period in Tally Prime by specifying a from date and to date. This changes the global period context used by Tally for subsequent report queries`,
        inputSchema: {
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('start date of the period'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('end date of the period')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let _fromDate = new Date(args.fromDate);
            let _toDate = new Date(args.toDate);
            let inputParams = new Map([['SVFromDate', utility.Date.format(_fromDate, 'd-MMM-yyyy')], ['SVToDate', utility.Date.format(_toDate, 'd-MMM-yyyy')]]);
            await invokeTallyAction('Change Period', inputParams);
            return { content: [{ type: 'text', text: JSON.stringify('OK') }] };
        }
        catch (err) {
            return {
                isError: true, content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('voucher-list', {
        title: 'Voucher List',
        description: `lists vouchers between dates with optional voucher type / party filter. fields Date, VoucherTypeName, VoucherNumber, Reference, PartyLedgerName, Amount (absolute amount of first ledger line), LedgerCount, Narration, MasterID, GUID, IsOptional, IsCancelled. result cached in pglite table (tableID) for query-database; summary with count and total amount per voucher type is returned`,
        inputSchema: {
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('from date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('to date'),
            voucherType: z.string().optional().describe('optional exact voucher type name e.g. Sales, Purchase, Payment, Receipt, Contra, Journal, Debit Note, Credit Note'),
            partyContains: z.string().optional().describe('optional case-insensitive text to match in party ledger name'),
            targetCompany: z.string().optional().describe('optional company name')
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            const fd = utility.Date.parse(args.fromDate, 'yyyy-MM-dd');
            const td = utility.Date.parse(args.toDate, 'yyyy-MM-dd');
            if (!fd || !td)
                return { isError: true, content: [{ type: 'text', text: 'invalid date' }] };
            const fmt = (d) => utility.Date.format(d, 'd-MMM-yyyy');
            const fields = ['Date', 'VoucherTypeName', 'VoucherNumber', 'Reference', 'PartyLedgerName', 'Amount', 'LedgerCount', 'Narration', 'MasterID', 'GUID', 'IsOptional', 'IsCancelled'];
            let rows = await queryCollection('Voucher', fields, new Map(), args.targetCompany, fd, td);
            rows = rows.filter((r) => (!r.Date || (r.Date >= fd && r.Date <= td))
                && (!args.voucherType || String(r.VoucherTypeName).toLowerCase() === args.voucherType.toLowerCase())
                && (!args.partyContains || String(r.PartyLedgerName || '').toLowerCase().includes(args.partyContains.toLowerCase())));
            const def = lstCollectionFields.filter(c => c.collection == 'Voucher')[0].fields;
            const meta = new Map();
            def.forEach(f => meta.set(f.name, f.datatype));
            const tableID = await cacheTable(meta, rows);
            const summary = {};
            for (const r of rows) {
                const k = r.VoucherTypeName;
                summary[k] = summary[k] || { count: 0, amount: 0 };
                summary[k].count++;
                summary[k].amount = Math.round((summary[k].amount + (isNaN(r.Amount) ? 0 : (r.Amount || 0))) * 100) / 100;
            }
            return { content: [{ type: 'text', text: JSON.stringify({ tableID, rows: rows.length, summary }) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err) }] };
        }
    });
    mcpServer.registerTool('inspect-xml-file', {
        title: 'Inspect XML File',
        description: `reads a Tally import XML file from the local computer WITHOUT importing and returns report name, company, number of TALLYMESSAGE, vouchers by type and ledgers. use before import-xml-file`,
        inputSchema: { filePath: z.string().describe('absolute path of the .xml file on this computer, e.g. C:\\Users\\me\\Downloads\\file.xml') },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        try {
            if (!/\.xml$/i.test(args.filePath))
                return { isError: true, content: [{ type: 'text', text: 'only .xml files are allowed' }] };
            return { content: [{ type: 'text', text: JSON.stringify(inspectXmlFile(args.filePath)) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err) }] };
        }
    });
    mcpServer.registerTool('gstin-verify', {
        title: 'Verify Supplier GSTINs',
        description: `verifies supplier GSTINs (from an .xlsx/.csv such as a GSTR-2A/2B or purchase register export, or a list) and writes an Excel report with GREEN / YELLOW / RED and reasons. checks: local format + check digit, GSTR-1 filing status from the client's own 2A/2B columns, and live registration data (status, legal / trade name, constitution, registration / cancellation date, nature of business) through the authorised gstinapi.in API when GSTINAPI_API_KEY is configured. results are cached on this computer (default 30 days) so a GSTIN is not paid for twice. never scrapes the GST portal. run with dryRun=true first to see how many credits are needed`,
        inputSchema: {
            filePath: z.string().optional().describe('absolute path of .xlsx or .csv with a column whose header contains GSTIN; optional columns: name, bills, taxable, gst, first date, last date, GSTR-1 filing status, fixed monthly (Y/N), remarks'),
            sheetName: z.string().optional(),
            gstins: z.array(z.string()).optional().describe('GSTINs to verify instead of / in addition to filePath'),
            clientName: z.string().describe('client name for the report and audit log'),
            clientProfile: z.enum(['pharmacy', 'trader', 'generic']).optional().default('generic'),
            outputPath: z.string().optional().describe('absolute path for the report .xlsx; default next to filePath or in the Aetherwise data folder'),
            useApi: z.boolean().optional().default(true).describe('false = offline checks only, no credits used'),
            maxApiLookups: z.number().int().min(0).max(5000).optional().default(25).describe('credit budget for this run; suppliers beyond it are left unverified (YELLOW)'),
            returnsFy: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('also fetch GSTR-1/3B filing history for this FY, e.g. 2026-27 (1 extra credit per GSTIN)'),
            cacheMaxAgeDays: z.number().int().min(0).max(365).optional().default(30),
            dryRun: z.boolean().optional().default(false).describe('true = no API calls; report shows how many credits a real run needs')
        },
        annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: true }
    }, async (args) => {
        try {
            const g = await import('./gstin.mjs');
            let rows = [];
            if (args.filePath)
                rows = await g.readSupplierFile(args.filePath, args.sheetName);
            if (args.gstins?.length)
                rows = rows.concat(args.gstins.map(x => ({ gstin: x })));
            if (!rows.length)
                return { isError: true, content: [{ type: 'text', text: 'no GSTINs found - give filePath or gstins' }] };
            const key = process.env.GSTINAPI_API_KEY || '';
            const provider = args.useApi !== false && key ? new g.GstinApiProvider(key) : null;
            const dir = g.dataDir();
            const cache = new g.GstinCache(path.join(dir, 'gstin-cache.json'));
            const { results, summary, calls } = await g.runVerification(rows, {
                clientName: args.clientName, profile: g.CLIENT_PROFILES[args.clientProfile || 'generic'], provider, cache,
                maxAgeDays: args.cacheMaxAgeDays ?? 30, maxApiLookups: args.maxApiLookups ?? 25, returnsFy: args.returnsFy, dryRun: args.dryRun
            });
            g.appendAudit(path.join(dir, 'gstin-audit.jsonl'), args.clientName, calls);
            const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
            const safe = args.clientName.replace(/[^A-Za-z0-9]+/g, '_');
            const out = args.outputPath || path.join(args.filePath ? path.dirname(args.filePath) : dir, `GSTIN_Verification_${safe}_${stamp}.xlsx`);
            await g.writeReport(out, results, summary, calls);
            const note = args.useApi !== false && !key ? 'GSTINAPI_API_KEY not configured - offline checks only. ' : '';
            const top = results.filter(r => r.colour !== 'GREEN').slice(0, 40).map(r => ({ gstin: r.local.gstin, name: r.input.name || r.record?.legalName || '', colour: r.colour, reasons: r.reasons }));
            return { content: [{ type: 'text', text: JSON.stringify({ note: note || undefined, report: out, summary, flagged: top }) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err) }] };
        }
    });
    mcpServer.registerTool('gstin-portal-open', {
        title: 'Open GST Portal Taxpayer Search',
        description: `opens the OFFICIAL GST portal "Search Taxpayer" page (${'https://services.gst.gov.in/services/searchtp'}) in the user's default browser. the user types the GSTIN and the captcha THEMSELVES, then saves the result page (Ctrl+S, "Webpage, Single File" .mhtml) or copies all text into a .txt. the connector sends nothing to the portal. next step: gstin-search-taxpayer`,
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: true }
    }, async () => {
        try {
            const { PORTAL_URL } = await import('./portal.mjs');
            const { spawn } = await import('node:child_process');
            const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', PORTAL_URL]]
                : process.platform === 'darwin' ? ['open', [PORTAL_URL]] : ['xdg-open', [PORTAL_URL]];
            spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
            return { content: [{ type: 'text', text: JSON.stringify({ opened: PORTAL_URL, steps: ['enter the GSTIN and press Enter', 'type the captcha yourself and click SEARCH', 'on the result page press Ctrl+S, choose "Webpage, Single File (*.mhtml)", save to a folder (e.g. Downloads\\GSTIN_<client>) with the GSTIN as file name', 'open the "Goods and Services" part before saving if the page shows it collapsed', 'repeat for each supplier, then ask Claude to run gstin-search-taxpayer on that folder'] }) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: 'could not open the browser: ' + String(err?.message || err) }] };
        }
    });
    mcpServer.registerTool('gstin-search-taxpayer', {
        title: 'Read GST Portal Taxpayer Result',
        description: `reads GST portal "Search Taxpayer" result pages that the USER saved or copied from the official portal (.mhtml / .html / .txt, or pasted text) and returns structured taxpayer details: legal / trade name, status, registration / cancellation date, constitution, taxpayer type, principal & additional places of business, centre / state jurisdiction, nature of core business and business activities, Aadhaar / e-KYC, and declared HSN / SAC goods and services, with field_availability for every field. fully offline: no request is sent to the portal or any other service, no API key needed. saveToCache=true stores the parsed record (with the page date) so gstin-verify can use it`,
        inputSchema: {
            gstin: z.string().optional().describe('expected GSTIN (checked against the page)'),
            filePath: z.string().optional().describe('absolute path of one saved page (.mhtml / .html / .txt)'),
            folderPath: z.string().optional().describe('absolute path of a folder with several saved pages; every .mhtml / .html / .txt is read'),
            text: z.string().max(400000).optional().describe('text copied from the result page (Ctrl+A, Ctrl+C)'),
            saveToCache: z.boolean().optional().default(false).describe('store parsed records in the local GSTIN cache for gstin-verify')
        },
        annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true }
    }, async (args) => {
        try {
            const p = await import('./portal.mjs');
            const g = await import('./gstin.mjs');
            const results = [];
            const files = [...(args.filePath ? [args.filePath] : []), ...(args.folderPath ? p.listPortalFiles(args.folderPath) : [])];
            for (const f of files) {
                try {
                    const { text, retrievedAt } = p.readPortalFile(f);
                    results.push(p.parsePortalText(text, { expectedGstin: files.length === 1 ? args.gstin : undefined, sourceFile: path.basename(f), retrievedAt }));
                }
                catch (e) {
                    results.push({ success: false, gstin: null, source_file: path.basename(f), page_state: 'UNRECOGNISED', error: 'could not read file: ' + String(e?.message || e) });
                }
            }
            if (args.text)
                results.push(p.parsePortalText(args.text, { expectedGstin: args.gstin, sourceFile: null, retrievedAt: null }));
            if (!results.length)
                return { isError: true, content: [{ type: 'text', text: 'give filePath, folderPath or text (run gstin-portal-open first to open the official search page)' }] };
            const savedSet = new Set();
            if (args.saveToCache) {
                const cache = new g.GstinCache(path.join(g.dataDir(), 'gstin-cache.json'));
                for (const r of results) {
                    const rec = p.toProviderRecord(r);
                    if (rec && rec.found) {
                        cache.put({ record: rec, source: p.PORTAL_SOURCE, verifiedAt: r.retrieved_at || r.parsed_at });
                        savedSet.add(rec.gstin);
                    }
                }
                cache.save();
            }
            const summary = { pages: results.length, parsed_ok: results.filter(r => r.success).length, not_found: results.filter(r => r.page_state === 'NOT_FOUND').length, failed: results.filter(r => !r.success && r.page_state !== 'NOT_FOUND').length, saved_to_cache: savedSet.size };
            return { content: [{ type: 'text', text: JSON.stringify({ summary, results }) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
        }
    });
    mcpServer.registerTool('gstin-verify-bulk', {
        title: 'Verify GSTINs on GST Portal (bulk, interactive)',
        description: `checks a list of GSTINs on the OFFICIAL GST portal in ONE request: opens one visible Edge / Chrome window on the user's PC, fills each GSTIN, and the USER types each captcha and clicks SEARCH (the connector never reads or solves captchas). each result is read and parsed automatically (legal / trade name, status, dates, constitution, type, address, jurisdiction, nature of business, HSN / SAC), compared with the supplier names in Tally ledgers (by GSTIN) and / or a supplier file, classified GREEN / YELLOW / RED (technical failures stay YELLOW, never RED) and written to one Excel report. runs in the background: returns at once with a job id - tell the user to switch to the browser window and type the captchas, then call gstin-verify-bulk-status. no API key, no paid service`,
        inputSchema: {
            gstins: z.array(z.string()).min(1).max(50).describe('GSTINs to check (duplicates removed, invalid ones not sent to the portal)'),
            clientName: z.string(),
            clientProfile: z.enum(['pharmacy', 'trader', 'generic']).optional().default('generic'),
            supplierFile: z.string().optional().describe('optional .xlsx / .csv (e.g. 2A summary) with GSTIN + supplier name / GST / GSTR-1 status for comparison'),
            compareWithTally: z.boolean().optional().default(true).describe('read party ledger names by GSTIN from the open Tally company (read-only)'),
            targetCompany: z.string().optional(),
            outputPath: z.string().optional().describe('report .xlsx path; default Aetherwise data folder'),
            perGstinTimeoutSec: z.number().int().min(30).max(900).optional().default(180).describe('time to type the captcha for one GSTIN'),
            saveToCache: z.boolean().optional().default(false).describe('also keep the parsed records in the local cache for gstin-verify')
        },
        annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: false }
    }, async (args) => {
        try {
            const g = await import('./gstin.mjs');
            const bj = await import('./bulkjob.mjs');
            const pb = await import('./portalbrowser.mjs');
            const books = new Map();
            const src = [];
            if (args.supplierFile) {
                for (const r of g.dedupeSuppliers(await g.readSupplierFile(args.supplierFile)).unique)
                    books.set(r.gstin, { name: r.name, gst: r.gst, bills: r.bills, gstr1Filed: r.gstr1Filed, fixedMonthly: r.fixedMonthly, firstDate: r.firstDate, lastDate: r.lastDate });
                src.push('supplier file ' + path.basename(args.supplierFile));
            }
            if (args.compareWithTally !== false) {
                try {
                    const led = await queryCollection('Ledger', ['Name', 'GSTN'], new Map(), args.targetCompany);
                    let n = 0;
                    for (const l of led) {
                        const gst = String(l.GSTN || l.gstn || '').trim().toUpperCase();
                        if (!gst || !args.gstins.map(x => x.trim().toUpperCase()).includes(gst))
                            continue;
                        const e = books.get(gst) || {};
                        if (!e.name)
                            e.name = l.Name ?? l.name;
                        books.set(gst, e);
                        n++;
                    }
                    src.push(`Tally ledgers (${n} matched by GSTIN)`);
                }
                catch {
                    src.push('Tally not reachable - books comparison from Tally not possible');
                }
            }
            const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
            const out = args.outputPath || path.join(g.dataDir(), `GSTIN_Portal_${args.clientName.replace(/[^A-Za-z0-9]+/g, '_')}_${stamp}.xlsx`);
            const job = bj.startBulk({
                gstins: args.gstins, clientName: args.clientName, profile: g.CLIENT_PROFILES[args.clientProfile || 'generic'], books,
                booksSource: src.join('; ') || 'no books source given', outputPath: out, saveToCache: !!args.saveToCache,
                perGstinTimeoutMs: (args.perGstinTimeoutSec ?? 180) * 1000, minGapMs: 3000, launch: pb.launchVisibleBrowser,
                portalUrl: process.env.AETHERWISE_PORTAL_URL_TEST
            });
            return { content: [{ type: 'text', text: JSON.stringify({ started: bj.publicView(job, false), user_action: 'A browser window is opening on the GST portal. For each supplier the GSTIN is already filled: type the captcha shown and click SEARCH. The next supplier opens automatically. Do not close the window until it finishes.', next: 'call gstin-verify-bulk-status (waitSeconds up to 50) until state is done' }) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err?.message || err).split('\n')[0] }] };
        }
    });
    mcpServer.registerTool('gstin-verify-bulk-status', {
        title: 'Bulk GSTIN Verification Status',
        description: 'progress / result of the running or last gstin-verify-bulk job. waitSeconds blocks until the job finishes or the wait ends. when done returns one row per supplier and the Excel report path. cancel=true stops after the current supplier',
        inputSchema: {
            waitSeconds: z.number().int().min(0).max(50).optional().default(0),
            cancel: z.boolean().optional().default(false)
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async (args) => {
        const bj = await import('./bulkjob.mjs');
        const j = bj.getJob();
        if (!j)
            return { content: [{ type: 'text', text: JSON.stringify({ state: 'none', message: 'no bulk job started in this session' }) }] };
        if (args.cancel)
            j.cancel = true;
        const until = Date.now() + (args.waitSeconds ?? 0) * 1000;
        while (j.state === 'running' && Date.now() < until)
            await new Promise(r => setTimeout(r, 1000));
        return { content: [{ type: 'text', text: JSON.stringify(bj.publicView(j, j.state !== 'running')) }] };
    });
    mcpServer.registerTool('gstin-api-usage', {
        title: 'GSTIN API Usage',
        description: 'returns usage / remaining credits of the configured gstinapi.in key (free call) and the size of the local GSTIN cache',
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: true }
    }, async () => {
        try {
            const g = await import('./gstin.mjs');
            const cache = new g.GstinCache(path.join(g.dataDir(), 'gstin-cache.json'));
            const key = process.env.GSTINAPI_API_KEY || '';
            const usage = key ? await new g.GstinApiProvider(key).usage() : 'gstinapi.in key not configured (optional - only gstin-verify live mode uses it; gstin-portal-open + gstin-search-taxpayer need no key)';
            return { content: [{ type: 'text', text: JSON.stringify({ usage, cachedGstins: cache.size, dataFolder: g.dataDir() }) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: String(err) }] };
        }
    });
    if (!isWriteBlocked) {
        mcpServer.registerTool('import-xml-file', {
            title: 'Import XML File',
            description: `imports a Tally XML file (masters or vouchers, Tally ENVELOPE format) from the local computer into Tally Prime, sending it in chunks. returns totals CREATED / ALTERED / ERRORS and Tally line errors. vouchers are always ADDED (never replaced), so never import the same file twice - check with voucher-list first`,
            inputSchema: {
                filePath: z.string().describe('absolute path of the .xml file on this computer'),
                targetCompany: z.string().optional().describe('optional company name; overrides SVCURRENTCOMPANY inside the file'),
                chunkSize: z.number().int().min(1).max(1000).optional().default(100).describe('number of TALLYMESSAGE per request, default 100')
            },
            annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: false }
        }, async (args) => {
            try {
                if (!/\.xml$/i.test(args.filePath))
                    return { isError: true, content: [{ type: 'text', text: 'only .xml files are allowed' }] };
                const result = await importXmlFile(args.filePath, args.chunkSize || 100, args.targetCompany);
                return { content: [{ type: 'text', text: JSON.stringify(result) }] };
            }
            catch (err) {
                return { isError: true, content: [{ type: 'text', text: String(err) }] };
            }
        });
        mcpServer.registerTool('voucher-delete-filtered', {
            title: 'Delete Vouchers by Filter',
            description: `finds vouchers by date range + voucher type (+ optional party text and MasterID range) and deletes them by MasterID. ALWAYS run first with dryRun=true (default) and show the count / total to the user; delete only after explicit user confirmation with dryRun=false and confirm=true`,
            inputSchema: {
                fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                voucherType: z.string().describe('exact voucher type name, e.g. Purchase'),
                partyContains: z.string().optional(),
                minMasterId: z.number().int().optional(),
                maxMasterId: z.number().int().optional(),
                dryRun: z.boolean().optional().default(true),
                confirm: z.boolean().optional().default(false),
                targetCompany: z.string().optional()
            },
            annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: true }
        }, async (args) => {
            try {
                const fd = utility.Date.parse(args.fromDate, 'yyyy-MM-dd');
                const td = utility.Date.parse(args.toDate, 'yyyy-MM-dd');
                if (!fd || !td)
                    return { isError: true, content: [{ type: 'text', text: 'invalid date' }] };
                let rows = await queryCollection('Voucher', ['Date', 'VoucherTypeName', 'VoucherNumber', 'PartyLedgerName', 'Amount', 'MasterID'], new Map(), args.targetCompany, fd, td);
                rows = rows.filter((r) => r.Date && r.Date >= fd && r.Date <= td
                    && String(r.VoucherTypeName).toLowerCase() === args.voucherType.toLowerCase()
                    && (!args.partyContains || String(r.PartyLedgerName || '').toLowerCase().includes(args.partyContains.toLowerCase()))
                    && (args.minMasterId === undefined || r.MasterID >= args.minMasterId)
                    && (args.maxMasterId === undefined || r.MasterID <= args.maxMasterId));
                const total = Math.round(rows.reduce((a, r) => a + (isNaN(r.Amount) ? 0 : r.Amount), 0) * 100) / 100;
                const ids = rows.map((r) => r.MasterID);
                const info = { matched: rows.length, totalAmount: total, minMasterId: ids.length ? Math.min(...ids) : null, maxMasterId: ids.length ? Math.max(...ids) : null };
                if (args.dryRun !== false || args.confirm !== true)
                    return { content: [{ type: 'text', text: JSON.stringify({ dryRun: true, ...info }) }] };
                const lst = rows.map((r) => ({ date: r.Date, voucherType: r.VoucherTypeName, tagName: 'MasterID', tagValue: String(r.MasterID) }));
                const res = { DELETED: 0, ERRORS: 0 };
                for (let i = 0; i < lst.length; i += 100) {
                    const r = await deleteVouchers(lst.slice(i, i + 100), args.targetCompany);
                    res.DELETED += parseInt(r?.DELETED || 0) || 0;
                    res.ERRORS += parseInt(r?.ERRORS || 0) || 0;
                }
                return { content: [{ type: 'text', text: JSON.stringify({ ...info, ...res }) }] };
            }
            catch (err) {
                return { isError: true, content: [{ type: 'text', text: String(err) }] };
            }
        });
        mcpServer.registerTool('voucher-delete', {
            title: 'Delete Vouchers',
            description: `deletes vouchers identified by date + voucher type + MasterID (preferred, from voucher-list) or voucher number. always list with voucher-list first and confirm with the user. confirm must be true`,
            inputSchema: {
                targetCompany: z.string().optional(),
                by: z.enum(['MasterID', 'VoucherNumber']).default('MasterID'),
                vouchers: z.array(z.object({
                    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                    voucherType: z.string(),
                    id: z.string().describe('MasterID or voucher number as per "by"')
                })).min(1).max(1000),
                confirm: z.literal(true).describe('must be true; only after user confirmation')
            },
            annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: true }
        }, async (args) => {
            try {
                const lst = args.vouchers.map(v => ({ date: utility.Date.parse(v.date, 'yyyy-MM-dd'), voucherType: v.voucherType, tagName: args.by === 'MasterID' ? 'MasterID' : 'Voucher Number', tagValue: v.id }));
                const total = {};
                for (let i = 0; i < lst.length; i += 100) {
                    const r = await deleteVouchers(lst.slice(i, i + 100), args.targetCompany);
                    for (const [k, v] of Object.entries(r || {}))
                        total[k] = (typeof v === 'number' ? (total[k] || 0) + v : v);
                }
                return { content: [{ type: 'text', text: JSON.stringify(total) }] };
            }
            catch (err) {
                return { isError: true, content: [{ type: 'text', text: String(err) }] };
            }
        });
        mcpServer.registerTool('ledger-create-update', {
            title: 'Create or Update Ledger',
            description: `create or update ledger master data in Tally Prime, returns success count of created and / or altered records`,
            inputSchema: {
                targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
                masters: z.array(z.object({
                    name: z.string().describe('ledger name or updated ledger name for modify / update'),
                    _name: z.string().optional().describe('old ledger name to modify / update, validate if ledger exists using list-master tool with collection as ledger'),
                    parent: z.string().optional().describe('group name for the ledger, validate if group exists using list-master tool with collection as group'),
                    openingBalance: z.number().optional().describe('optional opening balance for the ledger debit is negative and credit is positive'),
                    isBillWise: z.boolean().optional().describe('optional billwise or bill by bill tracking is enabled for the ledger, default is false, set it undefined to keep it unchanged'),
                    billCreditPeriod: z.number().optional().describe('optional bill credit period in number of days, applicable only if isBillWise is true, set it undefined to keep it unchanged'),
                    mailingDetails: z.object({
                        name: z.string().optional().describe('business name for mailing details, set it undefined to keep it unchanged, set it blank to reset it to Not Applicable'),
                        country: z.string().describe('country for mailing details, validate it using query-option-values tool with input optionName as country-state, set it blank to reset it to Not Applicable'),
                        state: z.string().describe('state for mailing details, validate it using query-option-values tool with input optionName as country-state, set it blank to reset it to Not Applicable'),
                        address: z.string().optional().describe('address for mailing details, set it blank to reset it'),
                        pincode: z.string().regex(/^\d{6}$/).optional().describe('pincode for mailing details 6 digit number, set it blank to reset it, set it undefined to keep it unchanged'),
                    }).optional().describe('optional mailing details for the ledger'),
                    gstRegistrationDetails: z.object({
                        gstin: z.string().regex(/^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{1}Z[0-9A-Z]{1}$/).describe('15 character GSTIN e.g. 06AADCB0822B1ZI'),
                        registrationType: z.enum(['Composition', 'Regular', 'Unregistered/Consumer', 'Government entity / TDS', 'Regular - SEZ', 'Regular-Deemed Exporter', 'Regular-Exports (EOU)', 'e-Commerce Operator', 'Input Service Distributor', 'Embassy/UN Body', 'Non-Resident Taxpayer']).optional().describe('GST registration type'),
                        placeOfSupply: z.string().optional().describe('place of supply for GST, validate it using query-option-values tool with input optionName as country-state with value of state property, set it blank to reset it to Not Applicable, set it undefined to keep it unchanged'),
                    }).optional().describe('optional GST registration details for the ledger (party ledgers). registrationType defaults to Regular'),
                    gstDutyHead: z.enum(['CGST', 'SGST/UTGST', 'IGST', 'Cess']).optional().describe('only for GST duty ledgers under Duties & Taxes: sets Type of Duty/Tax = GST and the GST duty head exactly as TallyPrime names it (CGST, SGST/UTGST, IGST, Cess)'),
                })).describe('array of master data objects to create or update'),
            },
            annotations: {
                readOnlyHint: false,
                openWorldHint: false,
                destructiveHint: true,
                idempotentHint: true
            }
        }, async (args) => {
            try {
                if (Array.isArray(args.masters) && args.masters.length > 0) {
                    let objMasterInput = new Map();
                    let lstObjMasters = [];
                    // assign books begin from date by calling queryCollection
                    let booksBeginFrom = new Date();
                    const resultBooksBeginFrom = await queryCollection('Company', ['Name', 'BooksFrom', 'IsActiveCompany'], new Map());
                    if (resultBooksBeginFrom.length === 0) {
                        return {
                            isError: true,
                            content: [{ type: 'text', text: 'No company found to determine books begin from date' }]
                        };
                    }
                    if (!args.targetCompany) { //choose Active company
                        booksBeginFrom = resultBooksBeginFrom.filter((item) => item.IsActiveCompany)[0].BooksFrom;
                    }
                    else { //choose specified target company
                        booksBeginFrom = resultBooksBeginFrom.filter((item) => item.Name === args.targetCompany)[0].BooksFrom;
                    }
                    args.masters.forEach((master) => {
                        let objLedger = {};
                        if (master._name)
                            objLedger._name = master._name;
                        if (master.name)
                            objLedger.name = master.name;
                        if (master.parent)
                            objLedger.parent = master.parent;
                        if (master.openingBalance !== undefined)
                            objLedger.openingBalance = master.openingBalance;
                        if (master.mailingDetails) {
                            objLedger.mailingDetails = master.mailingDetails;
                            objLedger.mailingDetails.applicableFrom = booksBeginFrom;
                        }
                        if (master.gstDutyHead)
                            objLedger.gstDutyHead = master.gstDutyHead;
                        if (master.gstRegistrationDetails) {
                            objLedger.gstRegistrationDetails = master.gstRegistrationDetails;
                            if (!objLedger.gstRegistrationDetails.registrationType)
                                objLedger.gstRegistrationDetails.registrationType = 'Regular';
                            objLedger.gstRegistrationDetails.applicableFrom = booksBeginFrom;
                        }
                        if (master.isBillWise !== undefined) {
                            objLedger.isBillWise = master.isBillWise;
                        }
                        if (master.isBillWise === true && master.billCreditPeriod !== undefined && typeof master.billCreditPeriod === 'number') {
                            let creditDays = Math.trunc(master.billCreditPeriod);
                            objLedger.billCreditPeriod = creditDays;
                        }
                        lstObjMasters.push(objLedger);
                    });
                    objMasterInput.set('masters', lstObjMasters);
                    if (args.targetCompany) {
                        objMasterInput.set('targetCompany', args.targetCompany);
                    }
                    let result = await importMastersTransactions('master-ledger', objMasterInput);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(result) }]
                    };
                }
                else {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: 'masters array is required with at least one master object to create or update' }]
                    };
                }
            }
            catch (err) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: JSON.stringify(err) }]
                };
            }
        });
        mcpServer.registerTool('delete-master', {
            title: 'Delete Master',
            description: `deletes a master object from selected collection in Tally Prime and returns success count of deleted records`,
            inputSchema: {
                targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
                collection: z.enum(lstCollections).describe('target collection for deletion, validate collection and object name using list-master tool where applicable'),
                name: z.array(z.string()).describe('list of name of that specific master object from that collection to delete, validate it using list-master tool with collection as the target collection before calling this tool')
            },
            annotations: {
                readOnlyHint: false,
                openWorldHint: false,
                destructiveHint: true,
                idempotentHint: true
            }
        }, async (args) => {
            try {
                const targetCollection = args.collection.trim();
                // validate if name exists for the specified collection before making delete call to avoid unnecessary processing and load on Tally
                let lstNames = await queryCollection(targetCollection, ['Name'], new Map(), args.targetCompany);
                // iterate through args.name and check if each name exists in lstNames, if any name is not found then return error with list of names not found, if all names are found then proceed with delete operation
                let lstNamesNotFound = [];
                args.name.forEach((name) => {
                    if (!lstNames.some((item) => item.Name === name)) {
                        lstNamesNotFound.push(name);
                    }
                });
                if (lstNamesNotFound.length > 0) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `No master object found with the given name(s) in the ${targetCollection} collection: ${lstNamesNotFound.join(', ')}. Kindly validate it using list-master tool` }]
                    };
                }
                const result = await deleteMasters(targetCollection, args.name, args.targetCompany);
                return {
                    content: [{ type: 'text', text: JSON.stringify(result) }]
                };
            }
            catch (err) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: JSON.stringify(err) }]
                };
            }
        });
        mcpServer.registerTool('voucher-journal', {
            title: 'Journal Voucher',
            description: `creates a journal voucher in Tally Prime`,
            inputSchema: {
                targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
                vouchers: z.array(z.object({
                    isoptional: z.boolean().optional().default(false).describe('indicates if the voucher is optional, to be used when user wants to be on safe side, if this option is set to true then notify user that they need to manually make it regular to effect the books of accounts'),
                    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('voucher date'),
                    voucherType: z.string().optional().default('Journal').describe('voucher type validate using list-master tool with collection as vouchertype'),
                    voucherNumber: z.string().optional().describe('voucher number for the voucher'),
                    narration: z.string().optional().describe('narration for the voucher'),
                    accountingEntry: z.array(z.object({
                        ledgerName: z.string().describe('ledger name validate it using list-master tool with collection as ledger'),
                        amount: z.number().describe('amount for the ledger, positive for credit and negative for debit')
                    })).min(2).describe('accounting entries for the voucher, at least two entries required, sum of amount should be zero')
                }))
            },
            annotations: {
                readOnlyHint: false,
                openWorldHint: false,
                destructiveHint: true,
                idempotentHint: false
            }
        }, async (args) => {
            try {
                let lstTargetVouchers = args.vouchers;
                // Validate voucher type exists in the system before proceeding by iterating through individual vouchers
                let lstVoucherTypeNames = lstTargetVouchers.map(v => v.voucherType);
                let lstInvalidVoucherTypes = await validateVoucherTypeParent(lstVoucherTypeNames, 'Journal', args.targetCompany);
                if (lstInvalidVoucherTypes.length > 0) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: JSON.stringify(`Invalid Voucher Type(s): ${lstInvalidVoucherTypes.join(', ')}`) }]
                    };
                }
                // check if valid date is entered for each voucher, convert date property to Date object in the vouchers object
                for (const voucher of lstTargetVouchers) {
                    const voucherDate = typeof voucher.date === 'string' ? utility.Date.parse(voucher.date, 'yyyy-MM-dd') : undefined;
                    if (voucherDate === null || voucherDate === undefined) {
                        return {
                            isError: true,
                            content: [{ type: 'text', text: JSON.stringify(`Invalid date for voucher: ${voucher.date}`) }]
                        };
                    }
                    voucher.date = voucherDate;
                }
                // validate if all the ledger names exist in the system before proceeding by iterating through individual vouchers and accountingEntry lines
                let lstLedgerNames = args.vouchers.map(v => v.accountingEntry.map(e => e.ledgerName)).flat();
                let invalidLedgerNames = await validateLedgers(lstLedgerNames, args.targetCompany);
                if (invalidLedgerNames.length > 0) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: JSON.stringify(`Invalid Ledger(s): ${invalidLedgerNames.join(', ')}`) }]
                    };
                }
                // iterate through each voucher and strip extra decimal places for accounting entry amounts
                for (const voucher of lstTargetVouchers) {
                    await stripExtraDecimalVoucherAmount(voucher);
                }
                // validate if the total of accounting entries sum to zero for each voucher
                for (const voucher of lstTargetVouchers) {
                    const isValid = await validateVoucherDebitCreditBalancing(voucher);
                    if (!isValid) {
                        return {
                            isError: true,
                            content: [{ type: 'text', text: JSON.stringify('accountingEntry Debit and Credit do not balance, amount must sum to zero') }]
                        };
                    }
                }
                let objVoucherInput = new Map();
                objVoucherInput.set('vouchers', lstTargetVouchers);
                if (args.targetCompany)
                    objVoucherInput.set('targetCompany', args.targetCompany);
                const result = await importMastersTransactions('voucher-journal', objVoucherInput);
                return {
                    content: [{ type: 'text', text: JSON.stringify(result) }]
                };
            }
            catch (err) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: JSON.stringify(err) }]
                };
            }
        });
    }
    return mcpServer;
}
//# sourceMappingURL=mcp.mjs.map