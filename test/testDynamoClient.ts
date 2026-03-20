import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb"
import { v4 as uuid } from "uuid"
import { ensureInstalled } from "../packages/event-store-dynamodb/src/eventStore/ensureInstalled"

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

    const client = DynamoDBDocumentClient.from(rawClient)
    await ensureInstalled(client, tableName)

    return { client, tableName }
}
