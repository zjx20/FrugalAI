import { Prisma, PrismaClient, User, ApiKey, Provider } from './generated/prisma';

/**
 * A data access class that provides methods for interacting with the database.
 * This class encapsulates all database operations for the application.
 * It must be instantiated with a PrismaClient instance.
 */
export class Database {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Finds a user by their authentication token. This is the primary method for authenticating a user's request.
   * It eagerly loads the user's API keys and their associated provider information.
   *
   * @param token The user's authentication token.
   * @returns A promise that resolves to the user object, including their API keys ("fleet keys"), or null if not found.
   */
  async findUserByToken(token: string): Promise<(User & { keys: (ApiKey & { provider: Provider })[] }) | null> {
    if (!token) {
      return null;
    }
    return this.prisma.user.findUnique({
      where: { token },
      include: {
        keys: {
          include: {
            provider: true,
          },
        },
      },
    });
  }

  /**
   * Retrieves an API key by its ID.
   * @param id The ID of the API key.
   * @returns A promise that resolves to the API key object, including provider and owner details, or null if not found.
   */
  async getApiKeyById(id: number): Promise<(ApiKey & { provider: Provider; owner: User }) | null> {
    return this.prisma.apiKey.findUnique({
      where: { id },
      include: {
        provider: true,
        owner: true,
      },
    });
  }

  /**
   * Updates the throttle data for a specific API key.
   * This is used to manage rate limiting and usage throttling.
   *
   * @param id The ID of the API key to update.
   * @param throttleData The new throttle data (must be a valid JSON object).
   * @returns A promise that resolves to the updated API key object.
   */
  async updateApiKeyThrottleData(id: number, throttleData: Prisma.InputJsonValue): Promise<ApiKey> {
    return this.prisma.apiKey.update({
      where: { id },
      data: { throttleData },
    });
  }

  /**
   * Updates an API key's data, such as its credentials or failure status.
   * @param id The ID of the API key to update.
   * @param data The data to update.
   * @returns A promise that resolves to the updated API key object.
   */
  async updateApiKey(id: number, data: { keyData?: Prisma.InputJsonValue; permanentlyFailed?: boolean }): Promise<ApiKey> {
    return this.prisma.apiKey.update({
      where: { id },
      data,
    });
  }

  /**
   * Retrieves all providers from the database.
   * @returns A promise that resolves to an array of all provider objects.
   */
  async getAllProviders(): Promise<Provider[]> {
    return this.prisma.provider.findMany();
  }

  /**
   * Retrieves a provider by its name.
   * @param name The name of the provider.
   * @returns A promise that resolves to the provider object, or null if not found.
   */
  async getProviderByName(name: string): Promise<Provider | null> {
    return this.prisma.provider.findUnique({
      where: { name },
    });
  }

  /**
   * Creates a new user.
   * @param token The user's authentication token.
   * @param name The user's name (optional).
   * @returns A promise that resolves to the newly created user object.
   */
  async createUser(token: string, name?: string): Promise<User> {
    return this.prisma.user.create({
      data: {
        token,
        name,
      },
    });
  }

  /**
   * Deletes a user by their ID.
   * @param id The ID of the user to delete.
   * @returns A promise that resolves to the deleted user object.
   */
  async deleteUser(id: number): Promise<User> {
    return this.prisma.user.delete({
      where: { id },
    });
  }

  /**
   * Creates a new API key.
   * @param ownerId The ID of the user who owns the key.
   * @param providerName The name of the provider for this key.
   * @param keyData The JSON data for the key.
   * @param throttleData The JSON data for throttling (optional).
   * @returns A promise that resolves to the newly created API key object.
   */
  async createApiKey(
    ownerId: number,
    providerName: string,
    keyData: Prisma.InputJsonValue,
    notes?: string,
    throttleData?: Prisma.InputJsonValue
  ): Promise<ApiKey> {
    return this.prisma.apiKey.create({
      data: {
        ownerId,
        providerName,
        keyData,
        notes,
        throttleData: throttleData || Prisma.JsonNull,
      },
    });
  }

  /**
   * Deletes an API key by its ID.
   * @param id The ID of the API key to delete.
   * @returns A promise that resolves to the deleted API key object.
   */
  async deleteApiKey(id: number): Promise<ApiKey> {
    return this.prisma.apiKey.delete({
      where: { id },
    });
  }
}
