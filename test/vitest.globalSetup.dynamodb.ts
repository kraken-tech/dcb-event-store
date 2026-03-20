import { GenericContainer, StartedTestContainer } from "testcontainers"

let container: StartedTestContainer

export async function setup() {
    container = await new GenericContainer("amazon/dynamodb-local")
        .withExposedPorts(8000)
        .start()

    const host = container.getHost()
    const port = container.getMappedPort(8000)
    process.env.__DYNAMODB_ENDPOINT = `http://${host}:${port}`
}

export async function teardown() {
    await container?.stop()
}
