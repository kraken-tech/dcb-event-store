import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb"
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand, ResourceNotFoundException } from "@aws-sdk/client-dynamodb"

const getRawClient = (client: DynamoDBDocumentClient): DynamoDBClient =>
    (client as unknown as { config: { client: DynamoDBClient } }).config.client ?? client

export const ensureInstalled = async (client: DynamoDBDocumentClient, tableName: string): Promise<void> => {
    const rawClient = getRawClient(client)

    try {
        await rawClient.send(new DescribeTableCommand({ TableName: tableName }))
        return
    } catch (e) {
        if (!(e instanceof ResourceNotFoundException)) throw e
    }

    await rawClient.send(
        new CreateTableCommand({
            TableName: tableName,
            KeySchema: [
                { AttributeName: "PK", KeyType: "HASH" },
                { AttributeName: "SK", KeyType: "RANGE" }
            ],
            AttributeDefinitions: [
                { AttributeName: "PK", AttributeType: "S" },
                { AttributeName: "SK", AttributeType: "S" }
            ],
            BillingMode: "PAY_PER_REQUEST"
        })
    )
}
