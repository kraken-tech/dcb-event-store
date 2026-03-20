import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb"
import { CreateTableCommand, DescribeTableCommand, ResourceNotFoundException } from "@aws-sdk/client-dynamodb"

export const ensureInstalled = async (client: DynamoDBDocumentClient, tableName: string): Promise<void> => {
    try {
        await client.send(new DescribeTableCommand({ TableName: tableName }))
        return
    } catch (e) {
        if (!(e instanceof ResourceNotFoundException)) throw e
    }

    await client.send(
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
