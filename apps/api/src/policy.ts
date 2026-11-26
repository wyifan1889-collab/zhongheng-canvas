/** Initial values explicitly confirmed by the user; review changes as business policy. */
export const accountPolicy = {
    login: { points: 10, duration: 60 },
    signup: { points: 5, duration: 60 * 60 },
    mail: { points: 3, duration: 10 * 60 },
    // Candidate R02 defaults: keep the same conservative bounds already used by
    // login/mail until a deployment-specific abuse budget is approved.
    verificationLink: { points: 10, duration: 60 },
    resetMail: { points: 3, duration: 10 * 60 },
    otpVerify: { points: 5, duration: 15 * 60 },
    resetSubmit: { points: 10, duration: 60 },
    read: { points: 120, duration: 60 },
    save: { points: 30, duration: 60 },
    documentBytes: 5 * 1024 * 1024,
    pageSize: 50,
    titleLength: 100,
};
export type AccountPolicy = typeof accountPolicy;
