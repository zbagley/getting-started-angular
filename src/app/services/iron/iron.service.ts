import * as IronWeb from '@ironcorelabs/ironweb';
import { Injectable } from '@angular/core';
import { User } from '../user/user';
import { from, Observable } from 'rxjs';
import { IronStatus } from './iron-status';
import { IronPolicyFactory } from './iron-policy-factory';

declare module '@ironcorelabs/ironweb' {
    let codec: Codec;
    let document: Document;
    let group: Group;
}

/**
 * EncryptedDocument maps the IronWeb encryption response to make it easier to
 * consume from an Angular application. In particular, id is mapped to an
 * integer so that it's easier to work with the mock InMemoryDataService which
 * expects an integer primary key.
 */
export class EncryptedDocument {
    id: Number;
    document: IronWeb.Base64Bytes;

    /**
     * Wrap the response, converting ids to Numbers for easier consumption
     * by Angular applications.
     * @param response The IronWeb response
     */
    constructor(response?: IronWeb.EncryptedDocumentResponse) {
        this.id = response ? +response.documentID : -1;
        this.document = response ? response.document : '';
    }

    // TODO: Error construction

    /**
     * Factory method to construct an EncryptedDocument from a json reponse
     *
     * @param json JSON representation of IronWeb.EncryptedDocumentResponse
     */
    static from(json: string): EncryptedDocument {
        return {
            id: json['id'],
            document: json['document']
        };
    }
}

/**
 * DecryptedDocument maps the IronWeb decryption response to make it easier to
 * consume from an Angular application. In particular, binary response data
 * is mapped to UTF8 and id is mapped to an integer so that it's easier to
 * work with the mock InMemoryDataService which expects an integer primary key.
 */
export class DecryptedDocument {
    id: Number;
    document: string;
    constructor(response?: IronWeb.DecryptedDocumentResponse) {
        if (response) {
            this.id = +response.documentID;
            this.document = IronWeb.codec.utf8.fromBytes(response.data);
        } else {
            this.id = -1;
            this.document = '{}';
        }
    }

    /**
     * Convenience factory function to construct a DecryptedDocument from an
     * IronWeb.SDKError.
     *
     * @param sdkError The inner IronWeb.SDKError
     */
    static from(sdkError: IronWeb.SDKError): DecryptedDocument {
        const result = new DecryptedDocument();
        result.document = JSON.stringify({
            __ironStatus: new IronStatus(sdkError)
        });
        return result;
    }
}

/**
 * Service pattern to wrap IronWeb, consistent with Angular best practices
 */
@Injectable({
    providedIn: 'root'
})
export class IronService {
    /**
     * The tutorial application switches users to demonstrate groups and data
     * control. This entails re-initializing the IronCore SDK. This would be an
     * unusual pattern in a typical application, but to support the tutorial we
     * serialize any re-initialization requests by beginning our call chain
     * from this Promise.
     */
    private p: Promise<any>;

    /** Construct an IronService, normally from DI */
    constructor(private ironPolicyFactory: IronPolicyFactory) {
        this.p = null;
    }

    /**
     * Add a single user to a group by id. The current user must be an
     * administrator of the group.
     *
     * @param user The user to add
     * @param groupID The group to add the user to
     */
    addUserToGroup(user: User, groupID: string): Observable<any> {
        // TODO: Wrap the return value and change Observable<any> to a
        // concrete type.
        return from(
            this.p.then(() => {
                return IronWeb.group.addMembers(groupID, [user.id]);
            })
        );
    }

    /**
     * Initialize the IronWeb SDK for the specified user. asUser requests
     * are serialized (i.e., with asUser(moe); asUser(curly); the curly asUser
     * will not begin until asUser(moe) completes
     *
     * @param user The user to activate ('login')
     */
    asUser(user: User): Promise<any> {
        // On the first time through, create a resolved Promise to avoid a null
        // dereference
        if (!this.p) {
            this.p = Promise.resolve();
        }

        // Serialize SDK requests on completion of previous asUser request
        return (this.p = this.p.then(() => {
            return IronWeb.initialize(
                () => this.getJWT(user.id),
                () => this.getUserPasscode()
            );
        }));
    }

    /**
     * Create a new transform encryption group
     *
     * @param options Group creation options
     */
    createGroup(options?: IronWeb.GroupCreateOptions) {
        return this.p.then(() => {
            return IronWeb.group.create(options);
        });
    }

    /**
     * Decrypt an encrypted document
     *
     * @param encryptedDocument The document to be decrypted
     */
    decrypt(encryptedDocument: EncryptedDocument): Observable<DecryptedDocument> {
        // Convert the Promise to an Observable
        return from(
            this.p
                .then(() => {
                    // Convert Number id to string id
                    return IronWeb.document
                        .decrypt('' + encryptedDocument.id, encryptedDocument.document)
                        .then(ddr => {
                            // Map the IronWeb response
                            return new DecryptedDocument(ddr);
                        });
                })
                .catch(error => {
                    // Catch SDKErrors and attach them to DecryptedDocument to
                    // simplify error handling
                    return DecryptedDocument.from(error);
                })
        );
    }

    /**
     * Encrypt the data transfer object as a JSON object
     */
    encrypt(dto: any): Observable<EncryptedDocument> {
        // TODO: Guard assertions and/or strong types
        const documentId = '' + dto.id;
        const documentData = IronWeb.codec.utf8.toBytes(JSON.stringify(dto));

        // Determine the group to encrypt to from the data transfer object
        // TODO: should policy return a full ACL config?
        const policy = this.ironPolicyFactory.from(dto);
        const groupId = policy.groupId;

        return from(
            this.p
                .then(() => {
                    return IronWeb.document
                        .encrypt(documentData, {
                            accessList: { groups: [{ id: groupId }] },
                            documentID: documentId
                        })
                        .then(response => {
                            return new EncryptedDocument(response);
                        });
                })
                .catch(() => {
                    // Catch SDKErrors and attach them to EncryptedDocument to
                    // simplify error handling
                    // TODO: Object construction
                    // TODO: Snackbar error?
                    return new EncryptedDocument();
                })
        );
    }

    //   TODO: change group ops to return observables
    /**
     * Get a cryptographic group by id
     *
     * @param groupID The group id to get
     */
    getGroup(groupID: string) {
        return this.p.then(() => {
            return IronWeb.group.get(groupID);
        });
    }

    /**
     * Request a signed JWT from the server for the current project and segment.
     */
    getJWT(userID) {
        // TODO: Catch and gracefully handle invalid JWT
        // TODO: See if we can eliminate node server dependency
        return fetch(`http://localhost:3001/generateJWT?userID=${userID}`)
            .then(response => response.text())
            .catch(e => {
                console.log(e);
                return '';
            });
    }

    /**
     * Mocked out method to get a users passcode. Fixed for now for PoC purposes.
     */
    getUserPasscode() {
        // TODO: Comment to explain why this is not best practice
        return Promise.resolve('SAMPLE_PASSCODE');
    }

    metadata(encryptedDocument: EncryptedDocument) {
        return from(
            this.p.then(() => {
                IronWeb.document
                    .getMetadata('' + encryptedDocument.id)
                    .then(response => {
                        console.log('getMetadata response', response);
                    });
            })
        );
    }

    /**
     * Remove a single user from a group by id. The current user must be an
     * administrator of the group.
     *
     * @param user The user to remove
     * @param groupID The group to remove the user from
     */
    removeUserFromGroup(user: User, groupID: string): Observable<any> {
        return from(
            this.p.then(() => {
                return IronWeb.group.removeMembers(groupID, [user.id]);
            })
        );
    }
}
