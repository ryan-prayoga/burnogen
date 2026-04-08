<?php

namespace App\Http\Requests;

use App\Enums\UserRole;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreUserRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:255'],
            'email' => 'required|email',
            'age' => ['nullable', 'integer', 'min:18'],
            'status' => [Rule::in(['draft', 'active'])],
            'members' => ['required', 'array'],
            'members.*.email' => ['required', 'email'],
            'members.*.role' => ['required', Rule::enum(UserRole::class)],
            'members.*.permissions' => ['array'],
            'members.*.permissions.*' => [Rule::in(['read', 'write'])],
            'profile' => ['nullable', 'array'],
            'profile.name' => ['required', 'string'],
            'profile.timezone' => ['nullable', 'string'],
        ];
    }
}
