<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;

class SessionController extends Controller
{
    public function check(Request $request)
    {
        abort_if(!$request->boolean('enabled'), 403, 'Feature disabled');

        return response()->json([
            'message' => 'Validation failed',
            'errors' => [
                'email' => ['The email field is required.'],
            ],
        ], 422);
    }

    public function store(Request $request)
    {
        $request->validate([
            'email' => 'required|email',
            'password' => ['required', 'string', 'min:8'],
        ]);

        $deviceName = $request->string('device_name');
        $rememberMe = $request->boolean('remember_me');
        $scopes = $request->array('scopes');
        $request->only(['tenant_id']);

        return response()->json([
            'message' => 'Logged in',
            'token' => 'demo-token',
            'device_name' => $deviceName,
            'remember_me' => $rememberMe,
            'scopes' => $scopes,
        ], 201);
    }
}
