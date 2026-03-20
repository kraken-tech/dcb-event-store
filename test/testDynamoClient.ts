import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb"
import { v4 as uuid } from "uuid"

export const getTestDynamoTable = async (): Promise<{
    client: DynamoDBDocumentClient
    tableName: string
}> => {
    const endpoint = process.env.__DYNAMODB_ENDPOINT
    if (!endpoint) throw new Error("DynamoDB container not started - is globalSetup configured?")

    const tableName = `test_${uuid().split("-").join("")}`

    const rawClient = new DynamoDBClient({
        endpoint,
        region: "local",
        credentials: { accessKeyId: "local", secretAccessKey: "local" }
    })

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

    return {
        client: DynamoDBDocumentClient.from(rawClient),
        tableName
    }
}
