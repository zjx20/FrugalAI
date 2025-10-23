import { Prisma, PrismaClient, User, ApiKey, Provider, ProviderName, ThrottleMode, AccessToken, TokenType } from '../generated/prisma';

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
          orderBy: {
            providerName: 'asc',
          },
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
  async updateApiKey(id: number, data: { keyData?: Prisma.InputJsonValue; permanentlyFailed?: boolean; throttleData?: Prisma.InputJsonValue }): Promise<ApiKey> {
    return this.prisma.apiKey.update({
      where: { id },
      data,
    });
  }

  /**
   * Updates the details of an API key, such as its credentials and notes.
   * @param id The ID of the API key to update.
   * @param data The data to update.
   * @returns A promise that resolves to the updated API key object.
   */
  async updateApiKeyDetails(id: number, data: { keyData?: Prisma.InputJsonValue; notes?: string }): Promise<ApiKey> {
    return this.prisma.apiKey.update({
      where: { id },
      data,
    });
  }

  /**
   * Resets an API key's throttling and error status, clearing all throttle data and permanent failure flags.
   * This allows a previously throttled or permanently failed key to be used again.
   * @param id The ID of the API key to reset.
   * @returns A promise that resolves to the updated API key object.
   */
  async resetApiKeyStatus(id: number): Promise<ApiKey> {
    return this.prisma.apiKey.update({
      where: { id },
      data: {
        throttleData: Prisma.JsonNull,
        permanentlyFailed: false,
      },
    });
  }

  /**
   * Pauses an API key by setting its `paused` flag to true.
   * This temporarily disables the key.
   * @param id The ID of the API key to pause.
   * @returns A promise that resolves to the updated API key object.
   */
  async pauseApiKey(id: number): Promise<ApiKey> {
    return this.prisma.apiKey.update({
      where: { id },
      data: { paused: true },
    });
  }

  /**
   * Unpauses an API key by setting its `paused` flag to false.
   * This re-enables a previously paused key.
   * @param id The ID of the API key to unpause.
   * @returns A promise that resolves to the updated API key object.
   */
  async unpauseApiKey(id: number): Promise<ApiKey> {
    return this.prisma.apiKey.update({
      where: { id },
      data: { paused: false },
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
  async getProviderByName(name: ProviderName): Promise<Provider | null> {
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
    providerName: ProviderName,
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

  /**
   * Updates a provider's configuration.
   * @param name The name of the provider to update.
   * @param data The data to update.
   * @returns A promise that resolves to the updated provider object.
   */
  async updateProvider(name: ProviderName, data: {
    throttleMode?: ThrottleMode;
    minThrottleDuration?: number;
    maxThrottleDuration?: number;
    models?: Prisma.InputJsonValue;
  }): Promise<Provider> {
    return this.prisma.provider.update({
      where: { name },
      data,
    });
  }

  /**
   * Creates a new provider.
   * @param name The name of the provider.
   * @param data The provider configuration data.
   * @returns A promise that resolves to the newly created provider object.
   */
  async createProvider(name: ProviderName, data: {
    throttleMode?: ThrottleMode;
    minThrottleDuration?: number;
    maxThrottleDuration?: number;
    models: Prisma.InputJsonValue;
  }): Promise<Provider> {
    return this.prisma.provider.create({
      data: {
        name,
        throttleMode: data.throttleMode || ThrottleMode.BY_KEY,
        minThrottleDuration: data.minThrottleDuration || 1,
        maxThrottleDuration: data.maxThrottleDuration || 15,
        models: data.models,
      },
    });
  }

  // AccessToken related methods

  /**
   * Finds an access token by its token string.
   * @param token The access token string.
   * @returns A promise that resolves to the access token object, or null if not found.
   */
  async findAccessToken(token: string): Promise<AccessToken | null> {
    if (!token) {
      return null;
    }
    return this.prisma.accessToken.findUnique({
      where: { token }
    });
  }

  /**
   * Finds a user by their ID and includes their API keys.
   * @param id The user ID.
   * @returns A promise that resolves to the user object with keys, or null if not found.
   */
  async findUserById(id: number): Promise<(User & { keys: (ApiKey & { provider: Provider })[] }) | null> {
    return this.prisma.user.findUnique({
      where: { id },
      include: {
        keys: {
          orderBy: {
            providerName: 'asc',
          },
          include: {
            provider: true,
          },
        },
      },
    });
  }

  /**
   * Creates a new access token for a user.
   * @param token The token string to use.
   * @param userId The ID of the user who owns the token.
   * @param name Optional name/description for the token.
   * @returns A promise that resolves to the newly created access token object.
   */
  async createAccessToken(token: string, userId: number, name?: string): Promise<AccessToken> {
    return this.prisma.accessToken.create({
      data: {
        token,
        type: TokenType.API,
        userId,
        name
      }
    });
  }

  /**
   * Revokes (deletes) an access token.
   * @param id The ID of the access token to revoke.
   * @returns A promise that resolves to the deleted access token object.
   */
  async revokeAccessToken(id: number): Promise<AccessToken> {
    return this.prisma.accessToken.delete({
      where: { id }
    });
  }

  /**
   * Gets all access tokens for a user.
   * @param userId The ID of the user.
   * @returns A promise that resolves to an array of access tokens.
   */
  async getUserAccessTokens(userId: number): Promise<AccessToken[]> {
    return this.prisma.accessToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Updates the model settings for a user.
   * @param userId The ID of the user.
   * @param modelSettings The new model settings (a JSON object with model configurations, or null to clear all settings).
   * @returns A promise that resolves to the updated user object.
   */
  async updateUserModelSettings(userId: number, modelSettings: Record<string, any> | null): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { modelSettings: modelSettings === null ? Prisma.JsonNull : modelSettings }
    });
  }

  /**
   * Updates extended fields of an API key (baseUrl and availableModels).
   * @param id The ID of the API key.
   * @param data The data to update (baseUrl and/or availableModels).
   * @returns A promise that resolves to the updated API key object.
   */
  async updateApiKeyExtendedFields(id: number, data: { baseUrl?: string; availableModels?: string[] | null }): Promise<ApiKey> {
    const updateData: any = {};
    if (data.baseUrl !== undefined) {
      updateData.baseUrl = data.baseUrl;
    }
    if (data.availableModels !== undefined) {
      updateData.availableModels = data.availableModels === null ? Prisma.JsonNull : data.availableModels;
    }
    return this.prisma.apiKey.update({
      where: { id },
      data: updateData
    });
  }
}
